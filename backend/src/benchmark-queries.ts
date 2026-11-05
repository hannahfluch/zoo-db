import type { Document, FindCursor } from "mongodb";
import type { PostgresStore } from "./postgres";
import type { MongoStore } from "./mongo";

export type Database = "postgres" | "mongo";
export type Target = Database | "both";
export type BenchmarkStores = { postgres: PostgresStore; mongo: MongoStore };

type QueryRows = { rows: number; modified: number | null; preview: Document[] };
export enum QueryId {
  FindAll = "find-all",
  FindFilter = "find-filter",
  FindProjection = "find-projection",
  FindSort = "find-sort",
  UpdateFilter = "update-filter",
  UpdateAll = "update-all",
  DeleteFilter = "delete-filter",
}

export const filterDate = "2026-01-01T00:00:00Z";
export const deleteDate = "2025-01-01T00:00:00Z";
export const reviewedNotes = "Benchmark reviewed";

// SQL and MongoDB syntax for the frontend. MongoDB execution uses the switch below.
export const benchmarkQueries = [
  {
    id: QueryId.FindAll,
    title: "Find without filter",
    kind: "find",
    sql: "SELECT * FROM checkups;",
    mongo: "db.checkups.find({})",
  },
  {
    id: QueryId.FindFilter,
    title: "Find with filter",
    kind: "find",
    sql: `SELECT * FROM checkups WHERE checked_at >= '${filterDate}';`,
    mongo: `db.checkups.find({ checkedAt: { $gte: ISODate("${filterDate}") } })`,
  },
  {
    id: QueryId.FindProjection,
    title: "Find with filter and projection",
    kind: "find",
    sql: `SELECT checked_at AS "checkedAt", notes FROM checkups WHERE checked_at >= '${filterDate}';`,
    mongo: `db.checkups.find({ checkedAt: { $gte: ISODate("${filterDate}") } }, { _id: 0, checkedAt: 1, notes: 1 })`,
  },
  {
    id: QueryId.FindSort,
    title: "Find with filter, projection and sort",
    kind: "find",
    sql: `
SELECT checked_at AS "checkedAt", notes
FROM checkups
WHERE checked_at >= '${filterDate}'
ORDER BY checked_at DESC, checkup_id::text DESC;
`.trim(),
    mongo: `
db.checkups.find(
  { checkedAt: { $gte: ISODate("${filterDate}") } },
  { _id: 0, checkedAt: 1, notes: 1 }
).sort({ checkedAt: -1, _id: -1 })
`.trim(),
  },
  {
    id: QueryId.UpdateFilter,
    title: "Update with filter",
    kind: "update",
    sql: `UPDATE checkups SET notes = '${reviewedNotes}' WHERE checked_at >= '${filterDate}';`,
    mongo: `
db.checkups.updateMany(
  { checkedAt: { $gte: ISODate("${filterDate}") } },
  { $set: { notes: "${reviewedNotes}" } }
)
`.trim(),
  },
  {
    id: QueryId.UpdateAll,
    title: "Update without filter",
    kind: "update",
    sql: `UPDATE checkups SET notes = '${reviewedNotes}';`,
    mongo: `db.checkups.updateMany({}, { $set: { notes: "${reviewedNotes}" } })`,
  },
  {
    id: QueryId.DeleteFilter,
    title: "Delete with filter",
    kind: "delete",
    sql: `DELETE FROM checkups WHERE checked_at < '${deleteDate}';`,
    mongo: `db.checkups.deleteMany({ checkedAt: { $lt: ISODate("${deleteDate}") } })`,
  },
] as const;

export interface QueryResult extends QueryRows {
  database: Database;
  queryId: QueryId;
  databaseMs: number;
  syncMs: number;
  totalMs: number;
  committed: boolean;
}

class RolledBack extends Error {
  constructor(public result: QueryResult) {
    super("Benchmark rollback");
  }
}

export function databases(target: Target): Database[] {
  return target === "both" ? ["postgres", "mongo"] : [target];
}

// Consume the complete result; keep only a small preview for the frontend.
async function readCursor(cursor: FindCursor, previewLimit: number): Promise<QueryRows> {
  let rows = 0;
  const preview: Document[] = [];
  for await (const document of cursor) {
    rows++;
    if (preview.length < previewLimit) preview.push(document);
  }
  return { rows, modified: null, preview };
}

export async function runQuery(
  stores: BenchmarkStores,
  database: Database,
  queryId: QueryId,
  commit = false,
  previewLimit = 25,
): Promise<QueryResult> {
  const query = benchmarkQueries.find(query => query.id === queryId)!;
  const started = performance.now();
  let databaseMs = 0;
  let syncMs = 0;
  let result: QueryRows = { rows: 0, modified: null, preview: [] };

  if (database === "postgres") {
    const client = await stores.postgres.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '120s'");

      const queryStarted = performance.now();
      const response = await client.query(query.sql);
      databaseMs = performance.now() - queryStarted;
      result = {
        rows: response.rowCount ?? 0,
        modified: null,
        preview: response.rows.slice(0, previewLimit),
      };

      await client.query(commit && query.kind !== "find" ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    const session = stores.mongo.client.startSession();
    try {
      try {
        await session.withTransaction(async () => {
          const queryStarted = performance.now();
          const checkups = stores.mongo.collection("checkups");
          const options = { session, maxTimeMS: 120000 };
          switch (queryId) {
            case QueryId.FindAll: {
              result = await readCursor(checkups.find({}, options), previewLimit);
              break;
            }
            case QueryId.FindFilter: {
              const cursor = checkups.find(
                { checkedAt: { $gte: new Date(filterDate) } },
                options,
              );
              result = await readCursor(cursor, previewLimit);
              break;
            }
            case QueryId.FindProjection: {
              const cursor = checkups.find(
                { checkedAt: { $gte: new Date(filterDate) } },
                { ...options, projection: { _id: 0, checkedAt: 1, notes: 1 } },
              );
              result = await readCursor(cursor, previewLimit);
              break;
            }
            case QueryId.FindSort: {
              const cursor = checkups.find(
                { checkedAt: { $gte: new Date(filterDate) } },
                { ...options, projection: { _id: 0, checkedAt: 1, notes: 1 } },
              ).sort({ checkedAt: -1, _id: -1 });
              result = await readCursor(cursor, previewLimit);
              break;
            }
            case QueryId.UpdateFilter: {
              const response = await checkups.updateMany(
                { checkedAt: { $gte: new Date(filterDate) } },
                { $set: { notes: reviewedNotes } },
                options,
              );
              result = { rows: response.matchedCount, modified: response.modifiedCount, preview: [] };
              break;
            }
            case QueryId.UpdateAll: {
              const response = await checkups.updateMany(
                {},
                { $set: { notes: reviewedNotes } },
                options,
              );
              result = { rows: response.matchedCount, modified: response.modifiedCount, preview: [] };
              break;
            }
            case QueryId.DeleteFilter: {
              const response = await checkups.deleteMany(
                { checkedAt: { $lt: new Date(deleteDate) } },
                options,
              );
              result = { rows: response.deletedCount, modified: null, preview: [] };
              break;
            }
          }
          databaseMs = performance.now() - queryStarted;

          // Managed writes also maintain the duplicated histories in both collections.
          const syncStarted = performance.now();
          if (query.kind === "update") {
            const entryFilter = queryId === QueryId.UpdateAll
              ? { "entry.id": { $exists: true } }
              : { "entry.checkedAt": { $gte: new Date(filterDate) } };

            for (const entity of ["animals", "employees"] as const) {
              await stores.mongo.collection(entity).updateMany(
                {},
                { $set: { "checkups.$[entry].notes": reviewedNotes } },
                { session, arrayFilters: [entryFilter] },
              );
            }
          }
          if (query.kind === "delete") {
            // Only oldest checkups are deleted, so remaining recent histories are complete.
            for (const entity of ["animals", "employees"] as const) {
              await stores.mongo.collection(entity).updateMany(
                {},
                { $pull: { checkups: { checkedAt: { $lt: new Date(deleteDate) } } } } as Document,
                { session },
              );
            }
          }
          syncMs = performance.now() - syncStarted;

          if (!commit) {
            throw new RolledBack({
              database, queryId, ...result, databaseMs, syncMs,
              totalMs: 0, committed: false,
            });
          }
        });
      } catch (error) {
        if (!(error instanceof RolledBack)) throw error;
      }
    } finally {
      await session.endSession();
    }
  }

  return {
    database,
    queryId,
    ...result,
    databaseMs,
    syncMs,
    totalMs: performance.now() - started,
    committed: commit && query.kind !== "find",
  };
}
