# Zoo benchmark client

Requires Python 3.10+ and the database created by `sql/01_schema.sql`.
From the repository root, start PostgreSQL with `docker compose up -d --build --wait`.
If your existing database uses an older schema, the root `reset-db.sh` recreates it
and **deletes all existing data**.

Install and run:

```sh
cd client
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m zoo_bench
```

The defaults append 20 enclosures, 20 employees, 1,000 animals and 1,000 checkups.
Every run uses a unique namespace for enclosure names and employee emails.
No tables are created, truncated or dropped by the client.

The client checks table columns before reserving IDs or inserting data. A schema
mismatch (for example, old required `location` or `species` columns) means the
running database has not been updated to the current SQL schema. Rebuilding the
image alone does not update an existing database volume. Use a new database with
the current schema or run the destructive root reset script described above.

Benchmark 100,000 animal inserts (plus 40 supporting rows):

```sh
python -m zoo_bench --animals 100000 --checkups 0 --batch-size 1000 --method executemany
```

Benchmark a larger related dataset using COPY:

```sh
python -m zoo_bench --animals 100000 --checkups 100000 --method copy \
  --batch-size 10000 --repeats 5 --warmups 1 --output results/copy-100k.json
```

`--animals` and `--checkups` are separate counts, not a combined row limit.
Use `--enclosures`, `--employees`, and `--seed` to control the other generated data.
Generation is deterministic for a seed and namespace; each CLI run randomizes only
the namespace to avoid unique-key collisions. All generated dates use fixed ranges.
The entire dataset and its mapped copy are held in memory, so memory grows with row count.

Connection defaults match Compose: localhost:5432, database/user `zoo`, password
`zoo_local_password`. Override with `DATABASE_URL`, or standard `PGHOST`, `PGPORT`,
`PGDATABASE`, `PGUSER`, `PGPASSWORD` environment variables. `POSTGRES_PORT` and
`POSTGRES_PASSWORD` are also supported as fallbacks. The client does not read `.env`
files automatically. Connection credentials are not included in reports.

```sh
PGDATABASE=zoo_test PGPORT=5433 python -m zoo_bench --animals 100
```

Insert modes:

| Mode | Behavior |
| --- | --- |
| `single` | One `execute` per record, one commit per batch |
| `executemany` | One driver `executemany` call per batch (default) |
| `copy` | PostgreSQL `COPY FROM STDIN` per batch |

Use `--method single --batch-size 1` to include a separate commit for every row.
COPY is a bulk-loading benchmark, not 100,000 individual SQL INSERT statements.
See the [Psycopg COPY documentation](https://www.psycopg.org/psycopg3/docs/basic/copy.html).

JSON reports include settings, versions, row counts before/after, generation and
connection time, identity allocation/mapping time, every insert batch, per-table
insert totals and throughput, ANALYZE time, and query samples with min/median/max.
Insert measurements include Python adaptation, network traffic and commit, but
exclude fake-data generation, identity allocation and batch slicing. Query timings
include execution, transfer and consuming every result row. They measure client
latency, not pure server execution time. Each query's result row count is also recorded.

The adapter updates planner statistics with ANALYZE before the queries. Warmups
are excluded from query samples, but included in total runtime. Queries cover counts,
an enclosure join (limited to 1,000 rows), enclosure populations, latest checkups,
and animals without checkups. Queries run against the **whole database**, including
pre-existing rows. Use equally initialized databases and identical settings when
comparing modes; repeated runs append data and warm caches. This is a sequential,
single-connection benchmark, not a concurrent load test.

Each batch commits independently. On failure, that batch rolls back; earlier
batches remain. The partial report records successful batches and the failed
operation. Reserved sequence values may be consumed even when insertion fails.
Output files are never silently overwritten.

Code layout:

- `data.py`: database-independent fake records and local relationships.
- `backend.py`: adapter protocol.
- `postgres.py`: identity mapping, PostgreSQL inserts, and query implementations.
- `runner.py`: backend-independent timings and summaries.
- `__main__.py`: CLI, connection configuration, and JSON output.

A future adapter can reuse the dataset and timing runner, map local IDs to its own
identifiers, and implement equivalent query workloads. No MongoDB code is included.

Run generator tests:

```sh
python -m unittest discover -s tests -v
```

To also run database integration tests, set `TEST_DATABASE_URL` to a test database:

```sh
TEST_DATABASE_URL='postgresql://zoo:zoo_local_password@localhost:5432/zoo_test' \
  python -m unittest discover -s tests -v
```

Integration tests create and remove their own randomly named schema within that
database. They check all insert modes, appending data, relationships, and batch rollback.
