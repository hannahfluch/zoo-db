import { batchIds, generateBatch, insertMongo, insertPostgres } from "./benchmark-data";
import type { Database } from "./benchmark-catalog";
import type { BenchmarkStores } from "./benchmark-queries";

export async function runInsertBenchmark(stores: BenchmarkStores, database: Database, count: number, seed: number, run: string) {
  const started = performance.now();
  const batch = generateBatch(count, seed, run);
  const generationMs = performance.now() - started;
  let databaseMs = 0;
  const record = (ms: number) => { databaseMs = ms; };
  if (database === "postgres") await insertPostgres(stores.postgres.pool, batch, () => {}, false, record);
  else await insertMongo(stores.mongo, batch, batchIds(batch), () => {}, false, record);
  return {
    database, queryId: "insert", recordsPerEntity: count, rows: count * 4,
    databaseMs, generationMs, totalMs: performance.now() - started, committed: false,
  };
}
