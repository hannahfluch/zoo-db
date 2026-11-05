# Test / benchmark frontend

Start the stack with `docker compose up -d --build` and open
**http://localhost:8081**. The data frontend stays at port 8080. Configure
`BENCHMARK_PORT` in `.env` to use another port.

## Data and reset

The batch buttons insert **100, 1,000, or 100,000 records into each entity**:
enclosures, employees, animals, and checkups. That is 400, 4,000, or 400,000 new
records per database. Batches append. Select both databases to reuse the same
generated values and PostgreSQL-assigned IDs in MongoDB. The random seed controls
the generated attributes and relationships; a random batch identifier keeps names
and emails unique when appending the same seed again.

Generation uses bulk writes in chunks of 1,000. PostgreSQL foreign keys and
MongoDB enclosure, parent, children, and recent-checkup views remain consistent.
Each database inserts its batch transactionally. The two databases commit
separately; if one fails after the other completes, the run records the successful
operation and the failure. Reset both and rerun to obtain matching datasets.

Reset clears the four entities in both databases and restarts PostgreSQL identity
sequences. It preserves indexes, collection definitions, database users, and the
MongoDB replica set. The frontend asks for confirmation. Reset, generation,
insertion, index changes, and queries all record runtime; PostgreSQL planner
statistics are refreshed after insertion.

## Queries

The frontend displays seven paired SQL and MongoDB presets from
`backend/src/benchmark-queries.ts`, each with a run button for either or both
databases. They operate on checkups:

| Operation | Equivalent behavior |
| --- | --- |
| Find without filter | All checkups |
| Find with filter | Examination date on or after 2026-01-01 UTC |
| Find with filter and projection | Same filter, returning examination date and notes |
| Find with filter, projection and sort | Same projected fields, sorted by examination date descending, then string ID descending |
| Update with filter | Set notes to `Benchmark reviewed` for dates on or after 2026-01-01 UTC |
| Update without filter | Set notes to `Benchmark reviewed` for all checkups |
| Delete with filter | Delete checkups before 2025-01-01 UTC |

MongoDB code uses normal `db.checkups.find(...)`, `updateMany(...)`,
`deleteMany(...)`, `ISODate(...)`, and `.sort(...)` syntax. The backend executes
these fixed presets through the database drivers. Their code panels remain
fixed; the separate custom-query section provides editable SQL and MongoDB text. PostgreSQL's snake_case columns map to MongoDB's
camelCase fields. Full records retain their native relational/document shapes;
projected query results have matching fields and values.

Finds consume the **entire cursor/result set**. The response shows at most 25
rows/documents as a preview. Updates report matched rows/documents; MongoDB also
reports documents whose values actually changed. Repeating an update can therefore
match records without modifying them.

Individual write queries roll back by default. Select **Keep changes** to commit
an update or delete after confirming it. MongoDB updates its embedded animal and
employee checkups in the same transaction. The delete predicate removes the oldest
examinations, so removing matching embedded entries preserves the latest remaining
history without leaving gaps.

## Custom query editors

The **Custom queries** section has independent SQL and MongoDB editors, individual
run buttons, and **Run both editors**. Load any preset into both editors, edit the
text, and run it. Ctrl+Enter runs the focused editor. Drafts are kept in browser
local storage. Each run is recorded in history with the executed text, affected or
returned count, database/operation runtime, and up to 25 preview rows/documents.
Both editors execute independently; the application does not assume arbitrary
edited queries are equivalent.

SQL accepts one `SELECT`, `WITH`, `INSERT`, `UPDATE`, `DELETE`, or `EXPLAIN`
statement, including joins, CTEs, projections, sorting, limits, and `RETURNING`.
PostgreSQL's extended-query protocol enforces the single-statement boundary.
Transaction-control and schema commands are not editor operations.

MongoDB accepts a single expression on one of the four collections, using
`db.checkups...` or `db.getCollection("checkups")...`:

- `find`, `findOne`, `aggregate`, `countDocuments`, and `distinct`.
- `insertOne`, `insertMany`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`,
  and `deleteMany`.
- Cursor methods `sort`, `project`, `skip`, `limit`, and `hint`, optionally ending
  with `toArray()`.
- Literal objects, arrays, strings, numbers, booleans, null, regular expressions,
  `ISODate(...)`, `new Date(...)`, and `ObjectId(...)` values.

MongoDB text is parsed into supported driver calls; it does not execute JavaScript
functions, variables, or general shell scripts in the backend. Read aggregation
pipelines work inside the transaction. Invalid syntax and database errors appear
in the recorded run.

Custom runs roll back by default. **Keep changes** commits the raw database
operation after confirmation. Raw MongoDB writes bypass embedded-copy maintenance
and relationship validation, so use the data frontend or managed presets for
writes that must keep the application model synchronized. Custom runs have a
120-second statement/operation timeout; finds consume their complete result and
only truncate the preview. PostgreSQL sequences can advance after rolled-back
inserts.

Custom-editor executions are timed individually. The k6 suite continues to use the
fixed presets and its configured insert workload, independently of editor drafts.

## With and without indexes

Index controls explicitly create or remove one optional benchmark index:

- PostgreSQL: `checkups (checked_at DESC, (checkup_id::text) DESC)`.
- MongoDB: `checkups { checkedAt: -1, _id: -1 }`.

Both are named `benchmark_checkups_date_idx`. They support the same examination
date filter and ordering. The benchmark UI reports whether each database currently
has this index. No benchmark indexes are created during normal application
startup. Primary-key and uniqueness indexes remain in both modes.

The suite can run without the index, with it, or compare both modes. It restores
the initial index settings afterward, including after a failed run. PostgreSQL
statistics are refreshed for each mode, followed by one unmeasured warm-up pass.
The comparison table shows means side by side. Indexes need not improve every
query: scans, small datasets, and write maintenance have different costs.

Each operation shows PostgreSQL and MongoDB side by side, with paired bars, the
faster measured database, the absolute difference, and the time ratio. Select full
operation time or database-call time, then mean, median, p95, p99, minimum, or
maximum. Bars use a separate scale for each operation. Detailed statistics and
the index-effect table remain available in expandable sections.

## k6 and timings

The backend container includes k6 1.4.0. No container-engine socket is exposed to
the application. The backend starts k6 as a child process and returns a job ID;
the frontend polls progress. Normal data-frontend writes are blocked while a test
job runs. Only one test job runs at a time.

Select **Inserts and all seven queries**, **Inserts only**, or **Queries only**.
Each k6 iteration runs that workload against each selected database. Iterations
are shared among the configured virtual users; they are not iterations per user.
The combined workload makes eight HTTP requests per database per iteration.

For inserts, choose 100, 1,000, or 100,000 records **per entity** and a random seed
in the k6 form. One insert request writes a complete related batch into all four
entities, including MongoDB embedded views. It reuses the normal bulk insertion
path, then rolls back the transaction. Each virtual user/iteration has a separate
batch identifier to avoid artificial unique-key conflicts; both databases receive
the same seeded attributes and relationships for that iteration.

Every write is rolled back, including inserts and embedded updates. Fixture rows
and documents remain unchanged across operations, iterations, and index modes.
PostgreSQL identity sequences still advance when an insert rolls back, so later
record IDs can contain gaps. Transactions can contend under multiple virtual users;
MongoDB retries transient transaction conflicts.

Results distinguish:

- **Database time:** driver call and full result consumption for the displayed
  primary query. For inserts, it sums the bulk driver calls across all four
  entities, including PostgreSQL parent assignments. It includes driver/network
  overhead, rather than claiming to be database-server execution time alone.
- **Generation time:** random attribute/relationship generation for each insert
  request. It is excluded from insert database time and included in operation time.
- **Embedded sync:** additional MongoDB writes maintaining duplicated checkups.
- **Operation time:** connection acquisition, transaction setup, query execution,
  data/document preparation, embedded sync, retries, and commit/rollback.
- **HTTP time:** k6 request duration, including API handling and response transfer.

k6 reports mean, minimum, maximum, median, p95 and p99, plus request counts and
failures. Index setup, statistics refresh, and warm-up are recorded separately
from measured query samples. Low iteration counts produce only a few samples;
use more iterations before interpreting percentiles.

The latest 50 jobs and their results remain in backend memory. **Download JSON**
exports the runs, including full k6 summaries. Restarting the backend clears this
history. Database contents persist in their volumes.

The k6 workload is in `backend/benchmarks/queries.js`. When running the backend
outside containers, install k6 or set `K6_BIN` to its executable path.

References: [k6 metrics](https://grafana.com/docs/k6/latest/using-k6/metrics/reference/),
[shared iterations](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/shared-iterations/),
and [custom summaries](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/benchmark/catalog` | Paired query code and labels |
| GET | `/api/benchmark/state` | Counts, benchmark index flags, k6 availability, active job |
| POST | `/api/benchmark/jobs` | Start an operation, returning HTTP 202 and a job |
| GET | `/api/benchmark/jobs` | Latest 50 jobs |
| GET | `/api/benchmark/jobs/{id}` | Job progress and results |

Job bodies:

```json
{ "action": "reset", "confirm": "RESET BOTH DATABASES" }
```

```json
{ "action": "insert", "target": "both", "count": 100000, "seed": 42 }
```

```json
{ "action": "indexes", "target": "both", "enabled": true }
```

```json
{ "action": "query", "target": "both", "queryId": "find-sort", "commit": false }
```

```json
{ "action": "custom", "target": "both", "sql": "SELECT * FROM checkups LIMIT 5;", "mongo": "db.checkups.find({}).limit(5)", "commit": false }
```

```json
{ "action": "suite", "target": "both", "indexes": "both", "iterations": 5, "vus": 1, "workload": "all", "insertCount": 1000, "seed": 42 }
```

Targets are `postgres`, `mongo`, or `both`. Suites accept index mode `off`, `on`,
or `both`, 1–100 total iterations, and 1–20 virtual users (no more than iterations).
Workloads are `all` (default), `queries`, or `inserts`. `insertCount` accepts 100,
1,000 (default), or 100,000; `seed` defaults to 42. Internal k6 query and insert
endpoints require the ephemeral token for an active suite.
