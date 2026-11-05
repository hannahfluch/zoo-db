import { describe, expect, test } from "bun:test";
import { parseMongoQuery, validateSql } from "../src/custom-queries";
import { benchmarkQueries, QueryId } from "../src/benchmark-queries";

describe("Editable MongoDB expressions", () => {
  test("parses the presets with their native values", () => {
    for (const query of benchmarkQueries) expect(parseMongoQuery(query.mongo).collection).toBe(query.id === QueryId.UniqueEmail ? "employees" : "checkups");
    const plan = parseMongoQuery('db.checkups.find({ checkedAt: { $gte: ISODate("2026-01-01T00:00:00Z") }, notes: /routine/i }, { notes: 1, _id: 0 }).sort({ checkedAt: -1 }).skip(1).limit(3).toArray()');
    expect(plan.operation.args[0].checkedAt.$gte).toBeInstanceOf(Date);
    expect(plan.operation.args[0].notes).toBeInstanceOf(RegExp);
    expect(plan.chain.map(call => call.name)).toEqual(["sort", "skip", "limit", "toArray"]);
  });
  test("supports getCollection, ObjectId and literal aggregation pipelines", () => {
    const plan = parseMongoQuery('db.getCollection("animals").aggregate([{ $match: { _id: ObjectId("0123456789abcdef01234567") } }, { $limit: 1 }])');
    expect(plan.collection).toBe("animals");
    expect(plan.operation.args[0][0].$match._id.toHexString()).toBe("0123456789abcdef01234567");
  });
  test("rejects scripts, functions and access to backend JavaScript", () => {
    for (const source of [
      'db.checkups.find({}); process.exit()',
      'db.checkups.find({ x: process.env })',
      'db.checkups.find({ x: (() => 1)() })',
      'db.checkups.find({ $where: () => true })',
      'db.checkups.find({}).constructor("return process")()',
      'db.dropDatabase()',
      'db.other.find({})',
      'db.checkups.find({}).limit(-1)',
      'db.checkups.find({ date: ISODate("invalid") })',
    ]) expect(() => parseMongoQuery(source)).toThrow();
  });
  test("preserves special object keys without changing the object prototype", () => {
    const filter = parseMongoQuery('db.animals.find({ "__proto__": { polluted: true } })').operation.args[0];
    expect(Object.getPrototypeOf(filter)).toBe(Object.prototype);
    expect(Object.hasOwn(filter, "__proto__")).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
  });
});
describe("Editable SQL", () => {
  test("accepts statement families and leading comments", () => {
    for (const source of ["SELECT 1;", "-- query\nSELECT ';' AS value;", "/* query */ WITH x AS (SELECT 1) SELECT * FROM x;", "EXPLAIN SELECT * FROM animals", "UPDATE checkups SET notes = 'Test'"]) expect(() => validateSql(source)).not.toThrow();
  });
  test("does not allow transaction or schema commands", () => {
    for (const source of ["COMMIT", "ROLLBACK", "DROP TABLE animals", "CREATE INDEX x ON checkups(notes)"]) expect(() => validateSql(source)).toThrow();
  });
});
