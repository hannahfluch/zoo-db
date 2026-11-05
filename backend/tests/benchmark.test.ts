import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import pg from "pg";
import { connect } from "../src/connections";
import { PostgresStore } from "../src/postgres";
import { MongoStore } from "../src/mongo";
import { BenchmarkService } from "../src/benchmark";
import { benchmarkQueries, filterDate, deleteDate, reviewedNotes, QueryId } from "../src/benchmark-queries";
import { createHandler } from "../src/api";
import { entities } from "../src/model";
import { runCustomQuery } from "../src/custom-queries";

describe.skipIf(process.env.RUN_INTEGRATION !== "1")("Benchmark frontend API", () => {
  const namespace = `bench_${crypto.randomUUID().replaceAll("-", "")}`;
  let connection: Awaited<ReturnType<typeof connect>>;
  let pool: pg.Pool, mongo: MongoStore, service: BenchmarkService;
  let handle: ReturnType<typeof createHandler>, server: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    connection = await connect();
    await connection.stores.postgres.pool.query(`CREATE SCHEMA ${namespace}`);
    pool = new pg.Pool({ ...connection.stores.postgres.pool.options, password: connection.stores.postgres.pool.options.password, options: `-c search_path=${namespace}` });
    await pool.query(await Bun.file(new URL("../../sql/01_schema.sql", import.meta.url)).text());
    mongo = new MongoStore(connection.stores.mongo.client, namespace);
    await mongo.init();
    const stores = { postgres: new PostgresStore(pool), mongo };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, fetch: request => handle(request) });
    service = new BenchmarkService(stores, server.url.origin);
    handle = createHandler(stores, service);
  }, 90000);
  afterAll(async () => {
    if (server) await server.stop();
    if (pool) await pool.end();
    if (connection) {
      await connection.stores.postgres.pool.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      if (mongo) await mongo.db.dropDatabase();
      await connection.close();
    }
  });
  const request = (path: string, body?: any) => handle(new Request(`http://test/api/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}));
  const state = async () => (await request("benchmark/state")).json();
  const job = async (body: any) => {
    const response = await request("benchmark/jobs", body);
    expect(response.status).toBe(202);
    let result = await response.json();
    const deadline = performance.now() + 600000;
    while (result.status === "running" && performance.now() < deadline) {
      await Bun.sleep(20);
      result = await (await request(`benchmark/jobs/${result.id}`)).json();
    }
    expect({ status: result.status, error: result.error }).toEqual({ status: "completed", error: undefined });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    return result.result;
  };
  test("validates destructive actions and blocks concurrent writes", async () => {
    expect((await request("benchmark/jobs", { action: "reset" })).status).toBe(400);
    expect((await request("benchmark/jobs", { action: "insert", count: 7, target: "both", seed: 42 })).status).toBe(400);
    expect((await request("benchmark/k6-query", { database: "mongo", queryId: "find-all" })).status).toBe(403);
    expect((await request("benchmark/k6-insert", { database: "mongo", batchKey: "1-0" })).status).toBe(403);
    expect((await request("benchmark/jobs", { action: "suite", target: "both", indexes: "both", iterations: 1, vus: 1, insertCount: 7 })).status).toBe(400);
    const initial = await request("benchmark/jobs", { action: "insert", count: 100, target: "both", seed: 42 });
    expect(initial.status).toBe(202);
    expect((await request("postgres/enclosures", { name: "Blocked", habitatType: "Savannah", areaSqm: 10 })).status).toBe(409);
    expect((await request("benchmark/jobs", { action: "indexes", target: "both", enabled: true })).status).toBe(409);
    let current = await initial.json();
    while (current.status === "running") { await Bun.sleep(20); current = await (await request(`benchmark/jobs/${current.id}`)).json(); }
    expect(current.status).toBe("completed");
  });
  test("generates matching records and consistent embedded relationships", async () => {
    const current = await state();
    for (const entity of entities) expect(current.counts.postgres[entity]).toBe(100);
    expect(current.counts.postgres).toEqual(current.counts.mongo);
    expect(current.indexes).toEqual({ postgres: false, mongo: false });
    const animals = await mongo.collection("animals").find({}).toArray();
    const byId = new Map(animals.map(a => [a._id, a]));
    expect(animals.reduce((sum, a) => sum + a.children.length, 0)).toBe(90);
    for (const animal of animals) {
      if (animal.parent) expect(byId.get(animal.parent.id)!.children.some((c: any) => c.id === animal._id)).toBe(true);
      const enclosure = await mongo.collection("enclosures").findOne({ _id: animal.enclosure.id });
      expect(enclosure!.animals.some((a: any) => a.id === animal._id)).toBe(true);
    }
    const pgIds = (await pool.query("SELECT checkup_id::text AS id FROM checkups ORDER BY checkup_id")).rows.map(r => r.id).sort();
    expect((await mongo.collection("checkups").distinct("_id")).sort()).toEqual(pgIds);
  });
  test("query pairs agree; rollback leaves records and embedded views unchanged", async () => {
    const original = await mongo.collection("checkups").find({}).sort({ _id: 1 }).toArray();
    const embedded = await mongo.collection("animals").find({}).sort({ _id: 1 }).toArray();
    for (const query of benchmarkQueries) {
      const result = await job({ action: "query", target: "both", queryId: query.id, commit: false });
      const [postgres, mongo] = result.operations;
      expect(postgres.rows).toBe(mongo.rows);
      expect(postgres.committed).toBe(false);
      expect(mongo.committed).toBe(false);
      if (query.id === QueryId.UniqueEmail) {
        expect(postgres.expectedError.code).toBe("23505");
        expect(mongo.expectedError.code).toBe("11000");
        expect(postgres.expectedError.message).toContain("email");
        expect(mongo.expectedError.message).toContain("email");
        expect((await state()).counts.postgres.employees).toBe(100);
        expect((await state()).counts.mongo.employees).toBe(100);
      }
      if (query.id === "find-sort") expect(JSON.parse(JSON.stringify(postgres.preview))).toEqual(JSON.parse(JSON.stringify(mongo.preview)));
      for (const operation of result.operations) expect(operation.databaseMs).toBeGreaterThanOrEqual(0);
    }
    expect(await mongo.collection("checkups").find({}).sort({ _id: 1 }).toArray()).toEqual(original);
    expect(await mongo.collection("animals").find({}).sort({ _id: 1 }).toArray()).toEqual(embedded);
    expect((await pool.query("SELECT notes FROM checkups ORDER BY checkup_id::text")).rows.map(r => r.notes)).toEqual(original.map(c => c.notes));
  }, 30000);
  test("index toggling is explicit and preserves uniqueness indexes", async () => {
    await job({ action: "indexes", target: "both", enabled: true });
    expect((await state()).indexes).toEqual({ postgres: true, mongo: true });
    await job({ action: "indexes", target: "both", enabled: false });
    expect((await state()).indexes).toEqual({ postgres: false, mongo: false });
    expect((await mongo.collection("employees").listIndexes().toArray()).some(i => i.unique && i.key.email === 1)).toBe(true);
  });
  test("committed updates/deletes match and keep all embedded checkups consistent", async () => {
    const filtered = await job({ action: "query", target: "both", queryId: "update-filter", commit: true });
    expect(filtered.operations[0].rows).toBe(filtered.operations[1].rows);
    expect(await mongo.collection("checkups").countDocuments({ checkedAt: { $gte: new Date(filterDate) }, notes: { $ne: reviewedNotes } })).toBe(0);
    await job({ action: "query", target: "both", queryId: "update-all", commit: true });
    const removed = await job({ action: "query", target: "both", queryId: "delete-filter", commit: true });
    expect(removed.operations[0].rows).toBe(removed.operations[1].rows);
    expect(await mongo.collection("checkups").countDocuments({ checkedAt: { $lt: new Date(deleteDate) } })).toBe(0);
    const authoritative = new Map((await mongo.collection("checkups").find({}).toArray()).map(c => [c._id, c]));
    for (const entity of ["animals", "employees"] as const) for (const owner of await mongo.collection(entity).find({}).toArray()) {
      const field = entity === "animals" ? "animal" : "employee";
      const expected = [...authoritative.values()].filter(c => c[field].id === owner._id).sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime() || (a._id < b._id ? 1 : -1)).slice(0, 100);
      expect(owner.checkups.map((c: any) => c.id)).toEqual(expected.map(c => c._id));
      expect(owner.checkups.every((c: any) => c.notes === reviewedNotes)).toBe(true);
    }
    expect((await state()).counts.postgres).toEqual((await state()).counts.mongo);
  });
  test("reset empties all entities, preserves index settings, and batches append", async () => {
    await job({ action: "indexes", target: "both", enabled: true });
    await job({ action: "reset", confirm: "RESET BOTH DATABASES" });
    const empty = await state();
    for (const database of ["postgres", "mongo"]) for (const entity of entities) expect(empty.counts[database][entity]).toBe(0);
    expect(empty.indexes).toEqual({ postgres: true, mongo: true });
    const rejected = await job({ action: "query", target: "both", queryId: QueryId.UniqueEmail, commit: true });
    expect(rejected.operations.map((operation: any) => operation.expectedError.code)).toEqual(["23505", "11000"]);
    expect(rejected.operations.every((operation: any) => operation.committed === false)).toBe(true);
    expect((await state()).counts).toEqual(empty.counts);
    await job({ action: "insert", target: "both", count: 1000, seed: 42 });
    expect((await pool.query("SELECT min(animal_id) FROM animals")).rows[0].min).toBe(1);
    await job({ action: "insert", target: "both", count: 100, seed: 42 });
    const added = await state();
    for (const entity of entities) expect(added.counts.postgres[entity]).toBe(1100);
    expect(added.counts.postgres).toEqual(added.counts.mongo);
    await job({ action: "indexes", target: "both", enabled: false });
  }, 60000);
  test.skipIf(!process.env.K6_BIN && !Bun.which("k6"))("k6 runs both index modes and restores the initial settings", async () => {
    const before = (await state()).counts;
    const result = await job({ action: "suite", target: "both", indexes: "both", iterations: 2, vus: 2, workload: "all", insertCount: 100, seed: 7 });
    expect(result.phases).toHaveLength(2);
    for (const phase of result.phases) {
      expect(phase.summary.metrics.http_reqs.values.count).toBe(32);
      expect(phase.summary.metrics.http_req_failed.values.rate).toBe(0);
      expect(phase.results).toHaveLength(16);
      for (const row of phase.results) expect(row.databaseMs.avg).toBeGreaterThanOrEqual(0);
      const inserts = phase.results.filter((row: any) => row.queryId === "insert");
      expect(inserts).toHaveLength(2);
      for (const row of inserts) {
        expect(row.recordsPerEntity).toBe(100);
        expect(row.generationMs.avg).toBeGreaterThanOrEqual(0);
        expect(row.operationMs.avg).toBeGreaterThanOrEqual(row.databaseMs.avg);
      }
    }
    expect((await state()).indexes).toEqual({ postgres: false, mongo: false });
    expect((await state()).counts).toEqual(before);
  }, 180000);
  test.skipIf(!process.env.K6_BIN && !Bun.which("k6"))("k6 inserts-only workload rolls back every entity and restores mixed index settings", async () => {
    await job({ action: "indexes", target: "mongo", enabled: true });
    const before = (await state()).counts;
    const animal = await mongo.collection("animals").findOne({});
    const result = await job({ action: "suite", target: "both", indexes: "off", iterations: 2, vus: 2, workload: "inserts", insertCount: 1000, seed: 42 });
    expect(result.phases[0].summary.metrics.http_reqs.values.count).toBe(4);
    expect(result.phases[0].summary.metrics.http_req_failed.values.rate).toBe(0);
    expect(result.phases[0].results.map((row: any) => row.queryId)).toEqual(["insert", "insert"]);
    expect((await state()).counts).toEqual(before);
    expect(await mongo.collection("animals").findOne({ _id: animal!._id })).toEqual(animal);
    expect((await state()).indexes).toEqual({ postgres: false, mongo: true });
    await job({ action: "indexes", target: "both", enabled: false });
    const queriesOnly = await job({ action: "suite", target: "both", indexes: "off", iterations: 1, vus: 1, workload: "queries", insertCount: 100000, seed: 42 });
    expect(queriesOnly.phases[0].summary.metrics.http_reqs.values.count).toBe(14);
    expect(queriesOnly.phases[0].results).toHaveLength(14);
    expect(queriesOnly.phases[0].results.every((row: any) => row.queryId !== "insert")).toBe(true);
    expect((await state()).counts).toEqual(before);
  }, 180000);
  test("custom editors run SQL and MongoDB reads, projections, aggregation and rollback", async () => {
    expect((await request("benchmark/jobs", { action: "custom", target: "both", sql: "SELECT 1" })).status).toBe(400);
    const before = (await state()).counts;
    const result = await job({ action: "custom", target: "both", sql: 'SELECT notes, checked_at AS "checkedAt" FROM checkups ORDER BY checked_at DESC, checkup_id::text DESC LIMIT 3 OFFSET 1;', mongo: 'db.checkups.find({}, { _id: 0, notes: 1, checkedAt: 1 }).sort({ checkedAt: -1, _id: -1 }).skip(1).limit(3).toArray()', commit: false });
    expect(result.operations[0].rows).toBe(3);
    expect(result.operations[0].preview).toEqual(result.operations[1].preview);
    const original = await mongo.collection("checkups").findOne({});
    const changed = await job({ action: "custom", target: "both", sql: "UPDATE checkups SET notes = 'Raw editor test';", mongo: 'db.checkups.updateMany({}, { $set: { notes: "Raw editor test" } })', commit: false });
    expect(changed.operations[0].rows).toBe(changed.operations[1].rows);
    expect(await mongo.collection("checkups").findOne({ _id: original!._id })).toEqual(original);
    expect((await pool.query("SELECT count(*) FROM checkups WHERE notes = 'Raw editor test'")).rows[0].count).toBe("0");
    const aggregate = await job({ action: "custom", target: "mongo", mongo: 'db.checkups.aggregate([{ $group: { _id: "$animal.id", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 2 }])', commit: false });
    expect(aggregate.operations[0].rows).toBe(2);
    expect(aggregate.operations[0].preview[0].count).toBeGreaterThan(0);
    expect((await state()).counts).toEqual(before);
  });
  test("custom insert/delete commit controls and single-statement SQL execution", async () => {
    const before = (await state()).counts;
    const statements = { sql: "INSERT INTO enclosures(name, habitat_type, area_sqm) VALUES ('Editor temporary', 'Savannah', 20) RETURNING enclosure_id;", mongo: 'db.enclosures.insertOne({ _id: "editor-temporary", name: "Editor temporary", habitatType: "Savannah", areaSqm: 20, animals: [] })' };
    await job({ action: "custom", target: "both", ...statements, commit: false });
    expect((await state()).counts).toEqual(before);
    const inserted = await job({ action: "custom", target: "both", ...statements, commit: true });
    expect(inserted.operations.map((operation: any) => operation.rows)).toEqual([1, 1]);
    expect((await state()).counts.mongo.enclosures).toBe(before.mongo.enclosures + 1);
    await job({ action: "custom", target: "both", sql: "DELETE FROM enclosures WHERE name = 'Editor temporary';", mongo: 'db.enclosures.deleteOne({ _id: "editor-temporary" })', commit: true });
    expect((await state()).counts).toEqual(before);
    const stores = { postgres: new PostgresStore(pool), mongo };
    await expect(runCustomQuery(stores, "postgres", "SELECT 1; DELETE FROM checkups", true)).rejects.toThrow();
    expect((await state()).counts).toEqual(before);
    const literal = await runCustomQuery(stores, "postgres", "SELECT ';' AS value;", false);
    expect(literal.preview).toEqual([{ value: ";" }]);
  });
  test.skipIf(process.env.RUN_LARGE_BENCHMARK !== "1")("100000 records per entity in both databases", async () => {
    await job({ action: "reset", confirm: "RESET BOTH DATABASES" });
    const result = await job({ action: "insert", target: "both", count: 100000, seed: 123 });
    for (const operation of result.operations) expect(operation.totalRecords).toBe(400000);
    const current = await state();
    for (const entity of entities) expect(current.counts.postgres[entity]).toBe(100000);
    expect(current.counts.postgres).toEqual(current.counts.mongo);
    const sorted = await job({ action: "query", target: "both", queryId: "find-sort", commit: false });
    expect(sorted.operations[0].preview).toEqual(sorted.operations[1].preview);
    if (process.env.K6_BIN || Bun.which("k6")) {
      const suite = await job({ action: "suite", target: "both", indexes: "both", iterations: 1, vus: 1, workload: "inserts", insertCount: 100000, seed: 42 });
      for (const phase of suite.phases) {
        expect(phase.summary.metrics.http_reqs.values.count).toBe(2);
        expect(phase.summary.metrics.http_req_failed.values.rate).toBe(0);
        expect(phase.results.every((row: any) => row.recordsPerEntity === 100000 && row.databaseMs.avg > 0)).toBe(true);
      }
      expect((await state()).counts).toEqual(current.counts);
    }
  }, 600000);
});
