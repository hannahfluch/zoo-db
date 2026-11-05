import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { HttpError, entities } from "./model";
import { benchmarkQueries, databases, type Database, type QueryId, type Target } from "./benchmark-catalog";
import { batchIds, generateBatch, insertMongo, insertPostgres } from "./benchmark-data";
import { runQuery, type BenchmarkStores } from "./benchmark-queries";
import { runInsertBenchmark } from "./benchmark-inserts";
import { runCustomQuery } from "./custom-queries";

const targetSchema = z.enum(["postgres", "mongo", "both"]);
const querySchema = z.enum(benchmarkQueries.map(q => q.id) as [QueryId, ...QueryId[]]);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset"), confirm: z.literal("RESET BOTH DATABASES") }).strict(),
  z.object({ action: z.literal("insert"), target: targetSchema, count: z.union([z.literal(100), z.literal(1000), z.literal(100000)]), seed: z.number().int().min(0).max(4294967295) }).strict(),
  z.object({ action: z.literal("indexes"), target: targetSchema, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("query"), target: targetSchema, queryId: querySchema, commit: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal("custom"), target: targetSchema, sql: z.string().trim().min(1).max(20000).optional(), mongo: z.string().trim().min(1).max(20000).optional(), commit: z.boolean().default(false) }).strict().superRefine((input, context) => {
    if (input.target !== "mongo" && !input.sql) context.addIssue({ code: "custom", path: ["sql"], message: "Enter a SQL statement." });
    if (input.target !== "postgres" && !input.mongo) context.addIssue({ code: "custom", path: ["mongo"], message: "Enter a MongoDB expression." });
  }),
  z.object({ action: z.literal("suite"), target: targetSchema, indexes: z.enum(["both", "on", "off"]), iterations: z.number().int().min(1).max(100), vus: z.number().int().min(1).max(20), workload: z.enum(["all", "queries", "inserts"]).default("all"), insertCount: z.union([z.literal(100), z.literal(1000), z.literal(100000)]).default(1000), seed: z.number().int().min(0).max(4294967295).default(42) }).strict(),
]);
export type Job = { id: string; action: string; status: "running" | "completed" | "failed"; startedAt: string; finishedAt?: string; durationMs?: number; progress: string; result?: any; error?: string };

export class BenchmarkService {
  jobs: Job[] = [];
  private active: Job | null = null;
  private k6Token = "";
  private k6Insert: { count: number; seed: number } | null = null;
  get busy() { return this.active !== null; }
  constructor(private stores: BenchmarkStores, private k6BaseUrl = "http://127.0.0.1:3000") {}
  async indexState(database: Database) {
    if (database === "postgres") return (await this.stores.postgres.pool.query("SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'benchmark_checkups_date_idx') AS enabled")).rows[0].enabled as boolean;
    return (await this.stores.mongo.collection("checkups").listIndexes().toArray()).some(i => i.name === "benchmark_checkups_date_idx");
  }
  async setIndexes(database: Database, enabled: boolean) {
    const started = performance.now();
    if (database === "postgres") {
      await this.stores.postgres.pool.query(enabled ? 'CREATE INDEX IF NOT EXISTS benchmark_checkups_date_idx ON checkups (checked_at DESC, (checkup_id::text) DESC)' : "DROP INDEX IF EXISTS benchmark_checkups_date_idx");
    } else if (enabled) await this.stores.mongo.collection("checkups").createIndex({ checkedAt: -1, _id: -1 }, { name: "benchmark_checkups_date_idx" });
    else if (await this.indexState(database)) await this.stores.mongo.collection("checkups").dropIndex("benchmark_checkups_date_idx");
    return { database, enabled, durationMs: performance.now() - started };
  }
  private async state() {
    return {
      counts: { postgres: await this.stores.postgres.stats(), mongo: await this.stores.mongo.stats() },
      indexes: { postgres: await this.indexState("postgres"), mongo: await this.indexState("mongo") },
      k6Available: !!Bun.which(process.env.K6_BIN || "k6"), active: this.active,
    };
  }
  private start(input: z.infer<typeof actionSchema>) {
    if (this.busy) throw new HttpError(409, "Another test operation is running.");
    if (input.action === "suite" && !Bun.which(process.env.K6_BIN || "k6")) throw new HttpError(503, "k6 is unavailable. Use the backend container, which includes k6.");
    if (input.action === "suite" && input.vus > input.iterations) throw new HttpError(400, "Virtual users cannot exceed iterations.");
    const job: Job = { id: randomUUID(), action: input.action, status: "running", startedAt: new Date().toISOString(), progress: "Starting", result: { request: input } };
    const started = performance.now();
    this.active = job;
    this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, 50);
    void this.perform(job, input).then(() => { job.status = "completed"; job.progress = "Completed"; }).catch(error => {
      console.error("Benchmark job failed:", error);
      job.status = "failed"; job.error = error.message; job.progress = "Failed";
    }).finally(() => { job.durationMs = performance.now() - started; job.finishedAt = new Date().toISOString(); this.active = null; });
    return job;
  }
  private async perform(job: Job, input: z.infer<typeof actionSchema>) {
    const progress = (stage: string) => { job.progress = stage; };
    const records: any[] = [];
    job.result.operations = records;
    if (input.action === "reset") {
      progress("Resetting PostgreSQL");
      let started = performance.now();
      await this.stores.postgres.pool.query("TRUNCATE checkups, animals, employees, enclosures RESTART IDENTITY");
      records.push({ database: "postgres", durationMs: performance.now() - started });
      progress("Resetting MongoDB");
      started = performance.now();
      const session = this.stores.mongo.client.startSession();
      try { await session.withTransaction(async () => { for (const entity of entities) await this.stores.mongo.collection(entity).deleteMany({}, { session }); }); }
      finally { await session.endSession(); }
      records.push({ database: "mongo", durationMs: performance.now() - started });
    }
    if (input.action === "insert") {
      progress("Generating shared random data");
      const began = performance.now();
      const batch = generateBatch(input.count, input.seed);
      job.result.generationMs = performance.now() - began;
      let ids = batchIds(batch);
      for (const database of databases(input.target)) {
        const started = performance.now();
        if (database === "postgres") ids = await insertPostgres(this.stores.postgres.pool, batch, progress);
        else await insertMongo(this.stores.mongo, batch, ids, progress);
        records.push({ database, recordsPerEntity: input.count, totalRecords: input.count * 4, durationMs: performance.now() - started });
      }
      progress("Refreshing PostgreSQL planner statistics");
      const analyzeStarted = performance.now();
      if (input.target !== "mongo") await this.analyze();
      job.result.analyzeMs = performance.now() - analyzeStarted;
    }
    if (input.action === "indexes") for (const database of databases(input.target)) {
      progress(`${input.enabled ? "Creating" : "Removing"} ${database} benchmark index`);
      records.push(await this.setIndexes(database, input.enabled));
    }
    if (input.action === "query") for (const database of databases(input.target)) {
      progress(`${database}: ${input.queryId}`);
      records.push({ ...await runQuery(this.stores, database, input.queryId, input.commit), indexEnabled: await this.indexState(database) });
    }
    if (input.action === "custom") for (const database of databases(input.target)) {
      progress(`${database}: custom query`);
      records.push(await runCustomQuery(this.stores, database, database === "postgres" ? input.sql! : input.mongo!, input.commit));
    }
    if (input.action === "suite") await this.suite(job, input, progress);
    job.result.state = await this.state();
    // Avoid embedding a reference to the active job inside its own result.
    delete job.result.state.active;
  }
  private async analyze() { for (const entity of entities) await this.stores.postgres.pool.query(`ANALYZE ${entity}`); }
  private async suite(job: Job, input: Extract<z.infer<typeof actionSchema>, { action: "suite" }>, progress: (stage: string) => void) {
    const targets = databases(input.target);
    const operations = input.workload === "inserts" ? ["insert"] : [...(input.workload === "all" ? ["insert"] : []), ...benchmarkQueries.map(query => query.id)];
    const original = { postgres: await this.indexState("postgres"), mongo: await this.indexState("mongo") };
    job.result.phases = [];
    job.result.originalIndexes = original;
    job.result.workload = { operations, insertCount: input.insertCount, seed: input.seed };
    try {
      for (const enabled of input.indexes === "both" ? [false, true] : [input.indexes === "on"]) {
        const phase: any = { indexed: enabled, indexOperations: [], results: [] };
        job.result.phases.push(phase);
        for (const database of targets) phase.indexOperations.push(await this.setIndexes(database, enabled));
        const analyzeStarted = performance.now();
        if (targets.includes("postgres")) await this.analyze();
        phase.analyzeMs = performance.now() - analyzeStarted;
        progress(`${enabled ? "With" : "Without"} benchmark index: warm-up`);
        const warmupStarted = performance.now();
        for (const database of targets) for (const operation of operations) {
          if (operation === "insert") await runInsertBenchmark(this.stores, database, input.insertCount, input.seed, randomUUID());
          else await runQuery(this.stores, database, operation as QueryId, false, 0);
        }
        phase.warmupMs = performance.now() - warmupStarted;
        progress(`${enabled ? "With" : "Without"} benchmark index: k6 ${input.iterations} iterations / ${input.vus} VUs`);
        this.k6Token = randomUUID();
        this.k6Insert = { count: input.insertCount, seed: input.seed };
        const path = `/tmp/zoo-k6-${job.id}-${enabled}.json`;
        const child = Bun.spawn([process.env.K6_BIN || "k6", "run", "--quiet", new URL("../benchmarks/queries.js", import.meta.url).pathname], {
          env: { ...Bun.env, BASE_URL: this.k6BaseUrl, BENCHMARK_TOKEN: this.k6Token, DATABASES: targets.join(","), OPERATIONS: operations.join(","), ITERATIONS: String(input.iterations), VUS: String(input.vus), SUMMARY_PATH: path },
          stdout: "pipe", stderr: "pipe",
        });
        const timeout = setTimeout(() => child.kill(), 660000);
        try {
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          phase.log = `${stdout}\n${stderr}`.slice(-20000);
          if (await Bun.file(path).exists()) phase.summary = await Bun.file(path).json();
          phase.exitCode = code;
          if (code !== 0) throw new Error(`k6 failed (exit ${code}). ${stderr.slice(-2000)}`);
          const metrics = phase.summary?.metrics || {};
          for (const database of targets) for (const operation of operations) phase.results.push({ database, queryId: operation, recordsPerEntity: operation === "insert" ? input.insertCount : undefined, databaseMs: metrics[`db_${database}_${operation.replaceAll("-", "_")}`]?.values, operationMs: metrics[`operation_${database}_${operation.replaceAll("-", "_")}`]?.values, generationMs: operation === "insert" ? metrics[`generation_${database}_insert`]?.values : undefined });
          const expected = input.iterations * targets.length * operations.length;
          if (metrics.http_reqs?.values.count !== expected) throw new Error("k6 did not complete the requested number of benchmark operations.");
        } finally { clearTimeout(timeout); this.k6Token = ""; this.k6Insert = null; await unlink(path).catch(() => {}); }
      }
    } finally {
      progress("Restoring benchmark index settings");
      job.result.restoredIndexes = [];
      for (const database of targets) job.result.restoredIndexes.push(await this.setIndexes(database, original[database]));
    }
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
    if (request.method === "GET" && url.pathname === "/api/benchmark/catalog") return reply({ queries: benchmarkQueries });
    if (request.method === "GET" && url.pathname === "/api/benchmark/state") return reply(await this.state());
    if (request.method === "GET" && url.pathname === "/api/benchmark/jobs") return reply(this.jobs);
    const jobMatch = url.pathname.match(/^\/api\/benchmark\/jobs\/([a-f0-9-]+)$/);
    if (request.method === "GET" && jobMatch) { const job = this.jobs.find(j => j.id === jobMatch[1]); if (!job) throw new HttpError(404, "Job not found"); return reply(job); }
    if (request.method === "POST" && url.pathname === "/api/benchmark/jobs") return reply(this.start(actionSchema.parse(await request.json())), 202);
    if (request.method === "POST" && url.pathname === "/api/benchmark/k6-query") {
      if (!this.k6Token || request.headers.get("x-benchmark-token") !== this.k6Token) throw new HttpError(403, "No active k6 benchmark session.");
      const input = z.object({ database: z.enum(["postgres", "mongo"]), queryId: querySchema }).strict().parse(await request.json());
      return reply(await runQuery(this.stores, input.database, input.queryId, false, 0));
    }
    if (request.method === "POST" && url.pathname === "/api/benchmark/k6-insert") {
      if (!this.k6Token || !this.k6Insert || request.headers.get("x-benchmark-token") !== this.k6Token) throw new HttpError(403, "No active k6 benchmark session.");
      const input = z.object({ database: z.enum(["postgres", "mongo"]), batchKey: z.string().regex(/^\d+-\d+$/).max(30) }).strict().parse(await request.json());
      return reply(await runInsertBenchmark(this.stores, input.database, this.k6Insert.count, this.k6Insert.seed, `${this.k6Token}-${input.batchKey}`));
    }
    throw new HttpError(404, "Benchmark route not found");
  }
}
