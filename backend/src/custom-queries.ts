import { parse } from "acorn";
import { ObjectId } from "mongodb";
import { entities, HttpError, type Entity } from "./model";
import type { Database } from "./benchmark-queries";
import type { BenchmarkStores } from "./benchmark-queries";

function invalid(message: string): never { throw new HttpError(400, message); }
function value(node: any, depth = 0): any {
  if (depth > 32) invalid("Query values are nested too deeply.");
  if (node.type === "Literal") return node.value;
  if (node.type === "ArrayExpression") return node.elements.map((entry: any) => entry ? value(entry, depth + 1) : invalid("Array holes are not supported."));
  if (node.type === "ObjectExpression") {
    const object: Record<string, any> = {};
    for (const property of node.properties) {
      if (property.type !== "Property" || property.computed || property.method || property.kind !== "init" || property.shorthand) invalid("Use literal object fields in MongoDB queries.");
      const key = property.key.type === "Identifier" ? property.key.name : String(property.key.value);
      Object.defineProperty(object, key, { value: value(property.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return object;
  }
  if (node.type === "UnaryExpression" && ["-", "+"].includes(node.operator)) {
    const number = value(node.argument, depth + 1);
    if (typeof number !== "number") invalid("Unary signs require a number.");
    return node.operator === "-" ? -number : number;
  }
  if (["CallExpression", "NewExpression"].includes(node.type) && node.callee.type === "Identifier") {
    const name = node.callee.name;
    if (!["ISODate", "Date", "ObjectId"].includes(name)) invalid("Supported value constructors: ISODate, Date, ObjectId.");
    if (node.arguments.length > 1) invalid(`${name} accepts at most one argument.`);
    const args = node.arguments.map((argument: any) => value(argument, depth + 1));
    if (name === "ObjectId") {
      if (args.length && (typeof args[0] !== "string" || !/^[a-f\d]{24}$/i.test(args[0]))) invalid("ObjectId requires a 24-character hexadecimal string.");
      return args.length ? new ObjectId(args[0]) : new ObjectId();
    }
    if (args.length && typeof args[0] !== "string" && typeof args[0] !== "number") invalid(`${name} requires a date string or timestamp.`);
    const date = args.length ? new Date(args[0]) : new Date();
    if (!Number.isFinite(date.getTime())) invalid("Invalid date.");
    return date;
  }
  return invalid("Use literal values, arrays, objects, regular expressions, ISODate(...) or ObjectId(...). JavaScript expressions and functions are not supported.");
}
function member(node: any) {
  if (node.type !== "MemberExpression" || node.optional) invalid("Use db.collection.method(...).");
  if (node.computed) {
    if (node.property.type !== "Literal" || typeof node.property.value !== "string") invalid("Collection and method names must be literal strings.");
    return node.property.value as string;
  }
  return node.property.name as string;
}
const methods = ["find", "findOne", "aggregate", "countDocuments", "distinct", "insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany"];
export function parseMongoQuery(source: string) {
  let tree: any;
  try { tree = parse(source, { ecmaVersion: "latest" }); }
  catch (error: any) { return invalid(`MongoDB syntax: ${error.message}`); }
  if (tree.body.length !== 1 || tree.body[0].type !== "ExpressionStatement") invalid("Enter one MongoDB collection expression.");
  let node = tree.body[0].expression;
  const calls: { name: string; args: any[] }[] = [];
  while (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    calls.unshift({ name: member(node.callee), args: node.arguments.map((argument: any) => value(argument)) });
    node = node.callee.object;
  }
  let collection: string;
  if (node.type === "Identifier" && node.name === "db" && calls[0]?.name === "getCollection") {
    const root = calls.shift()!;
    if (root.args.length !== 1 || typeof root.args[0] !== "string") invalid("getCollection requires a collection name.");
    collection = root.args[0];
  } else {
    collection = member(node);
    if (node.object.type !== "Identifier" || node.object.name !== "db") invalid("Start the query with db.<collection>.");
  }
  if (!entities.includes(collection as Entity)) invalid(`Collection must be one of: ${entities.join(", ")}.`);
  const operation = calls.shift();
  if (!operation || !methods.includes(operation.name)) invalid(`Supported operations: ${methods.join(", ")}.`);
  if (calls.length && !["find", "aggregate"].includes(operation.name)) invalid("Only find and aggregate support cursor methods.");
  for (const [index, call] of calls.entries()) {
    if (!["sort", "project", "skip", "limit", "hint", "toArray"].includes(call.name)) invalid("Supported cursor methods: sort, project, skip, limit, hint, toArray.");
    if (call.name === "toArray") {
      if (call.args.length || index !== calls.length - 1) invalid("toArray() must be the last cursor method, with no arguments.");
    } else if (call.args.length !== 1) invalid(`${call.name} requires one argument.`);
    if (["skip", "limit"].includes(call.name) && (!Number.isInteger(call.args[0]) || call.args[0] < 0)) invalid(`${call.name} requires a nonnegative integer.`);
  }
  return { collection: collection as Entity, operation, chain: calls };
}
function object(input: any, name: string): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input) || input instanceof Date || input instanceof RegExp || input instanceof ObjectId) invalid(`${name} must be an object.`);
  return input;
}
export function validateSql(source: string) {
  const statement = source.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  if (!/^(SELECT|WITH|INSERT|UPDATE|DELETE|EXPLAIN)\b/i.test(statement)) invalid("Use one SELECT, WITH, INSERT, UPDATE, DELETE or EXPLAIN statement.");
}
class CustomRollback extends Error {}
export async function runCustomQuery(stores: BenchmarkStores, database: Database, source: string, commit = false) {
  const started = performance.now();
  let databaseMs = 0, rows = 0, modified: number | null = null, command = "", preview: any[] = [];
  if (database === "postgres") {
    validateSql(source);
    const client = await stores.postgres.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '120s'");
      const began = performance.now();
      // Extended-query mode lets PostgreSQL enforce a single statement even
      // when strings, comments or dollar-quoted values contain semicolons.
      const config = { text: source, queryMode: "extended" };
      const result = await client.query(config);
      databaseMs = performance.now() - began;
      rows = result.rowCount || 0; command = result.command; preview = result.rows.slice(0, 25);
      await client.query(commit ? "COMMIT" : "ROLLBACK");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } else {
    const plan = parseMongoQuery(source);
    const session = stores.mongo.client.startSession();
    try {
      await session.withTransaction(async () => {
        rows = 0; modified = null; preview = [];
        const collection = stores.mongo.db.collection(plan.collection);
        const { name, args } = plan.operation;
        command = name;
        const maxArgs = ["find", "findOne", "distinct"].includes(name) ? 2 : ["updateOne", "updateMany", "replaceOne"].includes(name) ? 3 : 1;
        if (args.length > maxArgs) invalid(`${name} accepts at most ${maxArgs} arguments.`);
        const options = { session, maxTimeMS: 120000 };
        const began = performance.now();
        if (["find", "aggregate"].includes(name)) {
          if (name === "aggregate" && !Array.isArray(args[0])) invalid("aggregate requires a pipeline array.");
          let cursor: any = name === "find" ? collection.find(object(args[0] ?? {}, "Filter"), { ...options, projection: args[1] === undefined ? undefined : object(args[1], "Projection") }) : collection.aggregate(args[0], options);
          try {
            for (const call of plan.chain) {
              if (call.name === "toArray") continue;
              if (typeof cursor[call.name] !== "function") invalid(`${call.name} is unsupported for this cursor.`);
              cursor = cursor[call.name](call.args[0]);
            }
            for await (const document of cursor) { rows++; if (preview.length < 25) preview.push(document); }
          } finally { await cursor.close(); }
        } else if (name === "findOne") {
          const document = await collection.findOne(object(args[0] ?? {}, "Filter"), { ...options, projection: args[1] === undefined ? undefined : object(args[1], "Projection") });
          if (document) { rows = 1; preview = [document]; }
        } else if (name === "countDocuments") {
          rows = await collection.countDocuments(object(args[0] ?? {}, "Filter"), options); preview = [{ count: rows }];
        } else if (name === "distinct") {
          if (typeof args[0] !== "string") invalid("distinct requires a field name.");
          const values = await collection.distinct(args[0], object(args[1] ?? {}, "Filter"), options);
          rows = values.length; preview = values.slice(0, 25).map(value => ({ value }));
        } else if (name === "insertOne") {
          const result = await collection.insertOne(object(args[0], "Document"), options);
          rows = 1; preview = [{ insertedId: result.insertedId }];
        } else if (name === "insertMany") {
          if (!Array.isArray(args[0]) || !args[0].length) invalid("insertMany requires a nonempty document array.");
          const result = await collection.insertMany(args[0].map((doc: any) => object(doc, "Document")), options);
          rows = result.insertedCount; preview = Object.values(result.insertedIds).slice(0, 25).map(insertedId => ({ insertedId }));
        } else if (["updateOne", "updateMany", "replaceOne"].includes(name)) {
          const settings = args[2] === undefined ? {} : object(args[2], "Options");
          const result = await collection[name as "updateOne" | "updateMany" | "replaceOne"](object(args[0], "Filter"), object(args[1], "Update/replacement"), { ...settings, ...options });
          rows = result.matchedCount + result.upsertedCount; modified = result.modifiedCount;
          preview = [{ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, upsertedCount: result.upsertedCount, upsertedId: result.upsertedId }];
        } else {
          const result = await collection[name as "deleteOne" | "deleteMany"](object(args[0], "Filter"), options);
          rows = result.deletedCount; preview = [{ deletedCount: rows }];
        }
        databaseMs = performance.now() - began;
        if (!commit) throw new CustomRollback("Custom query rolled back");
      });
    } catch (error) { if (!(error instanceof CustomRollback)) throw error; }
    finally { await session.endSession(); }
  }
  return { database, queryId: "custom", command, databaseMs, syncMs: 0, totalMs: performance.now() - started, rows, modified, preview, committed: commit };
}
