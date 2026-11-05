export const filterDate = "2026-01-01T00:00:00Z";
export const deleteDate = "2025-01-01T00:00:00Z";
export const reviewedNotes = "Benchmark reviewed";
export const benchmarkQueries = [
  { id: "find-all", title: "Find without filter", kind: "find", sql: "SELECT * FROM checkups;", mongo: "db.checkups.find({})" },
  { id: "find-filter", title: "Find with filter", kind: "find", sql: `SELECT * FROM checkups WHERE checked_at >= '${filterDate}';`, mongo: `db.checkups.find({ checkedAt: { $gte: ISODate("${filterDate}") } })` },
  { id: "find-projection", title: "Find with filter and projection", kind: "find", sql: `SELECT checked_at AS "checkedAt", notes FROM checkups WHERE checked_at >= '${filterDate}';`, mongo: `db.checkups.find(\n  { checkedAt: { $gte: ISODate("${filterDate}") } },\n  { _id: 0, checkedAt: 1, notes: 1 }\n)` },
  { id: "find-sort", title: "Find with filter, projection and sort", kind: "find", sql: `SELECT checked_at AS "checkedAt", notes FROM checkups\nWHERE checked_at >= '${filterDate}'\nORDER BY checked_at DESC, checkup_id::text DESC;`, mongo: `db.checkups.find(\n  { checkedAt: { $gte: ISODate("${filterDate}") } },\n  { _id: 0, checkedAt: 1, notes: 1 }\n).sort({ checkedAt: -1, _id: -1 })` },
  { id: "update-filter", title: "Update with filter", kind: "update", sql: `UPDATE checkups SET notes = '${reviewedNotes}'\nWHERE checked_at >= '${filterDate}';`, mongo: `db.checkups.updateMany(\n  { checkedAt: { $gte: ISODate("${filterDate}") } },\n  { $set: { notes: "${reviewedNotes}" } }\n)` },
  { id: "update-all", title: "Update without filter", kind: "update", sql: `UPDATE checkups SET notes = '${reviewedNotes}';`, mongo: `db.checkups.updateMany({}, { $set: { notes: "${reviewedNotes}" } })` },
  { id: "delete-filter", title: "Delete with filter", kind: "delete", sql: `DELETE FROM checkups WHERE checked_at < '${deleteDate}';`, mongo: `db.checkups.deleteMany({ checkedAt: { $lt: ISODate("${deleteDate}") } })` },
] as const;
export type QueryId = typeof benchmarkQueries[number]["id"];
export type Database = "postgres" | "mongo";
export type Target = Database | "both";
export const databases = (target: Target): Database[] => target === "both" ? ["postgres", "mongo"] : [target];
