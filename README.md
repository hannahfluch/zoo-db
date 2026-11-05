# Zoo database

A zoo management app with PostgreSQL 17 and MongoDB 8.0 persistence, a shared
TypeScript/Bun REST backend, and an independent data frontend.

The embedded MongoDB model is documented in
[MongoDB document structure](docs/mongodb-structure.md), including four collections,
embedded frontend views, and rules for keeping duplicated data consistent.

| Table | Fields | Purpose |
| --- | --- | --- |
| `animals` | 5 | Animal details, enclosure, and one optional recorded parent |
| `enclosures` | 4 | Enclosure details |
| `employees` | 5 | Employee details |
| `checkups` | 5 | One examination of one animal by one employee |

```mermaid
erDiagram
    enclosures ||--o{ animals : houses
    animals o|--o{ animals : "recorded parent of"
    animals ||--o{ checkups : receives
    employees ||--o{ checkups : performs
```

Each animal belongs to exactly one enclosure and has zero or one recorded parent.
One parent can have multiple offspring. The model records one optional parent
per animal. Each checkup references
exactly one animal and one employee. An animal or employee may have many checkups.

The model is in third normal form: fields hold single values, each table describes
one entity, and non-key attributes depend on that table's key without transitive
dependencies. Animal rows reference enclosures rather than copying their details;
checkups reference animals and employees rather than duplicating their attributes.

The required `habitat_type` uses the PostgreSQL enum `enclosure_type`:
`Savannah`, `Grassland`, `Coastal`, or `Tropical rainforest`.

The database enforces these constraints:

- Identity primary keys uniquely identify every record.
- `NOT NULL` applies to all fields except the optional `animals.parent_id`.
- `UNIQUE` applies to enclosure names and employee emails.
  Animal and employee names may repeat in real life, so they are not unique.
- `CHECK` requires positive enclosure areas, rejects empty or space-only checkup
  notes, and rejects direct self-parenting.
- The enclosure enum restricts habitats to the four listed values.
- Foreign keys require existing animals, enclosures, and employees. Deleting an
  animal cascades to its checkups and clears its offspring's recorded parent.
  Occupied enclosures and employees with checkups cannot be deleted.

Longer ancestry cycles, biological parentage rules, and cross-table date checks
(such as a checkup occurring after birth) are outside this small model.

Requires Docker with Docker Compose.
Start both databases, the backend, and the data frontend from this directory:

```sh
docker compose up -d --build
```

After startup, open **http://localhost:8080**. The API is available at
`http://localhost:3000/api`. Startup can take a minute; inspect readiness with
`docker compose ps` or `curl http://localhost:3000/api/health`.

The separate **test / benchmark frontend** is at **http://localhost:8081**. It
resets both databases, inserts 100 / 1,000 / 100,000 random records per entity,
runs seven equivalent SQL/MongoDB query pairs, and uses k6 to benchmark inserts
and queries with and without a benchmark index. See [benchmark usage and timings](docs/benchmark.md).

The data frontend provides lists, record counts, literal case-insensitive search,
pagination, linked detail pages, complete related histories, and create/edit forms
for all four entities, with delete actions on detail pages. The database selector changes where reads and writes go;
data is independent between PostgreSQL and MongoDB. Creating a record does not
copy it into the other database. Deletes require confirmation. Deleting an animal also deletes all its checkups
and clears its offspring's recorded parent; the offspring remain. Occupied
enclosures and employees with checkups cannot be deleted.

Optionally populate an **empty** MongoDB database from the existing PostgreSQL
records, including embedded views:

```sh
docker compose exec backend bun run seed:mongo
```

The import refuses to overwrite any existing MongoDB records. Run it while no
clients are writing to PostgreSQL so the copied relationships remain consistent.
It is an initial data import, not a scalable benchmark generator.

Copy `.env.example` to `.env` to customize credentials and host ports. For logs:

```sh
docker compose logs backend
docker compose logs mongo
```

## Backend and frontend separation

```text
backend/              Shared REST API, database adapters, validation, tests
frontends/data/       Independent HTML/CSS/JS data frontend, served by nginx
frontends/benchmark/  Independent test and benchmark frontend, served by nginx
mongo/                MongoDB image with persistent replica-set key
sql/                  PostgreSQL schema and initial data
```

Both frontends have their own directory, image, and Compose service. They share
the backend described in [docs/api.md](docs/api.md) without importing each other's
code. The data frontend nginx service proxies
`/api/` to the backend, keeping browser requests on the same origin. Another
frontend should configure a similar proxy; the API does not enable cross-origin
browser access by default. The backend does not serve frontend files.

## Development and checks

With Bun installed, run from `backend/`:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run dev
```

The backend defaults to the local database ports and development credentials.
For customized settings, export `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`,
`PGPASSWORD`, and `MONGO_URL` (include authentication in the URI, or set
`MONGO_PASSWORD` and optionally `MONGO_USERNAME`). Compose already supplies its
container settings. `MONGO_DATABASE` defaults to `zoo`.

With the Compose databases running, execute the integration tests from
`backend/`:

```sh
bun run test:integration
```

These create and remove a uniquely named PostgreSQL schema and MongoDB database;
they do not reset existing app records. They verify creation, duplicates,
relationship validation, search, pagination, related histories, concurrent MongoDB
writes, edits, deletion restrictions, embedded-copy propagation, and the 100-entry
embedded checkup limit with history backfilling after deletion. Cascade tests
cover complete histories and surviving offspring.

## Database reference

The PostgreSQL database is available at `localhost:5432`, database/user `zoo`, password
`zoo_local_password`. These are local development credentials. Optionally set
`POSTGRES_PASSWORD` and `POSTGRES_PORT` in a local `.env` before the first start.

MongoDB 8.0 is available at `localhost:27017`, with user `zoo`, password
`zoo_mongo_local_password`, and authentication database `admin`. Its connection URI is:

```text
mongodb://zoo:zoo_mongo_local_password@localhost:27017/zoo?authSource=admin&directConnection=true
```

Optionally set `MONGO_PASSWORD` and `MONGO_PORT` in `.env` before the first start.
Both database ports bind only to localhost. MongoDB stores data in its own named
volume, `zoo_mongo_data`. Credentials are initialized only on an empty volume;
changing `.env` later does not change existing users' passwords. This follows the
[official MongoDB image](https://hub.docker.com/_/mongo) configuration.

Open an authenticated MongoDB shell (uses the configured password):

```sh
docker compose exec mongo sh -c 'exec mongosh zoo --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
```

The backend creates the four MongoDB collections at startup, with unique indexes
only for enclosure names and employee emails. No extra relationship or search
indexes are created at startup. The benchmark frontend can explicitly toggle its
optional date index. PostgreSQL keeps its primary-key and UNIQUE constraints.
MongoDB runs as a single-node replica set; the backend initializes it on the first start.
Its internal authentication key is stored in the `zoo_mongo_config` volume.
Creates, edits, and deletes update MongoDB records and their embedded views in
transactions. MongoDB initially has no records; see the optional import above.

Open an SQL shell or run all seven example queries:

```sh
docker compose exec db psql -U zoo -d zoo
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U zoo -d zoo < queries.sql
```

`sql/01_schema.sql` creates the tables; `sql/02_seed.sql` inserts 4 enclosures,
4 employees, 8 animals, and 8 checkups. The seed script assumes a freshly created
schema. Both scripts run automatically, in filename order, on the first start.
Initialization scripts only run when the data directory is empty, as documented
by the [official PostgreSQL image](https://hub.docker.com/_/postgres).

Stop the stack while preserving data:

```sh
docker compose down
```

To recreate the schema and sample data after editing the initialization scripts,
run the reset script. It rebuilds the PostgreSQL image, removes the data and replica-key
volumes, and starts the stack again. PostgreSQL receives its schema and sample
data; MongoDB starts empty. **This deletes all PostgreSQL and MongoDB zoo data:**

```sh
./reset-db.sh
```

Without containers, run the SQL against an existing empty PostgreSQL database:

```sh
psql -v ON_ERROR_STOP=1 -d zoo -f sql/01_schema.sql
psql -v ON_ERROR_STOP=1 -d zoo -f sql/02_seed.sql
psql -v ON_ERROR_STOP=1 -d zoo -f queries.sql
```
