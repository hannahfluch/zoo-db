import type { ClientSession, Filter, Document } from "mongodb";
import type { PostgresStore } from "./postgres";
import type { MongoStore } from "./mongo";
import { benchmarkQueries, deleteDate, filterDate, reviewedNotes, type Database, type QueryId } from "./benchmark-catalog";

export type BenchmarkStores = { postgres: PostgresStore; mongo: MongoStore };
export type QueryResult = { database: Database; queryId: QueryId; databaseMs: number; syncMs: number; totalMs: number; rows: number; modified: number | null; committed: boolean; preview: any[] };
class RolledBack extends Error { constructor(public result: QueryResult) { super("Benchmark rollback"); } }

export async function runQuery(stores: BenchmarkStores, database: Database, queryId: QueryId, commit = false, previewLimit = 25): Promise<QueryResult> {
  const query = benchmarkQueries.find(q => q.id === queryId)!;
  const started = performance.now();
  const write = query.kind !== "find";
  let databaseMs = 0, syncMs = 0, rows = 0, modified: number | null = null, preview: any[] = [];
  if (database === "postgres") {
    const client = await stores.postgres.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '120s'");
      const began = performance.now();
      const result = await client.query(query.sql);
      databaseMs = performance.now() - began;
      rows = result.rowCount || 0;
      preview = result.rows.slice(0, previewLimit);
      await client.query(write && commit ? "COMMIT" : "ROLLBACK");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } else {
    const session = stores.mongo.client.startSession();
    try {
      const execute = async (session: ClientSession) => {
        rows = 0; preview = [];
        const filter: Filter<Document & { _id: string }> = queryId === "find-all" || queryId === "update-all" ? {} : { checkedAt: query.kind === "delete" ? { $lt: new Date(deleteDate) } : { $gte: new Date(filterDate) } };
        const began = performance.now();
        if (query.kind === "find") {
          const projected = queryId === "find-projection" || queryId === "find-sort";
          let cursor = stores.mongo.collection("checkups").find(filter, { session, projection: projected ? { _id: 0, checkedAt: 1, notes: 1 } : undefined, maxTimeMS: 120000 });
          if (queryId === "find-sort") cursor = cursor.sort({ checkedAt: -1, _id: -1 });
          for await (const document of cursor) { rows++; if (preview.length < previewLimit) preview.push(document); }
        } else if (query.kind === "update") {
          const result = await stores.mongo.collection("checkups").updateMany(filter, { $set: { notes: reviewedNotes } }, { session });
          rows = result.matchedCount; modified = result.modifiedCount;
        } else rows = (await stores.mongo.collection("checkups").deleteMany(filter, { session })).deletedCount;
        databaseMs = performance.now() - began;
        const syncStart = performance.now();
        if (query.kind === "update") {
          const entryFilter = queryId === "update-all" ? { "entry.id": { $exists: true } } : { "entry.checkedAt": { $gte: new Date(filterDate) } };
          for (const entity of ["animals", "employees"] as const) await stores.mongo.collection(entity).updateMany({}, { $set: { "checkups.$[entry].notes": reviewedNotes } }, { session, arrayFilters: [entryFilter] });
        }
        if (query.kind === "delete") {
          // The predicate removes oldest entries: every surviving examination
          // was already ahead of deleted entries in each recent-history array.
          for (const entity of ["animals", "employees"] as const) await stores.mongo.collection(entity).updateMany({}, { $pull: { checkups: { checkedAt: { $lt: new Date(deleteDate) } } } } as any, { session });
        }
        syncMs = performance.now() - syncStart;
        const result = { database, queryId, databaseMs, syncMs, totalMs: 0, rows, modified, committed: write && commit, preview };
        if (!commit) throw new RolledBack(result);
        return result;
      };
      try { await session.withTransaction(() => execute(session)); }
      catch (error) { if (!(error instanceof RolledBack)) throw error; }
    } finally { await session.endSession(); }
  }
  return { database, queryId, databaseMs, syncMs, totalMs: performance.now() - started, rows, modified, committed: write && commit, preview };
}
