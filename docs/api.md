# Shared zoo API

The backend is independent of the frontends. Base URL: `http://localhost:3000/api`.
The data frontend accesses it through its own nginx proxy at `/api`.
This is a local development API without application-user authentication.

Replace `{database}` with `postgres` or `mongo`, and `{entity}` with `animals`,
`enclosures`, `employees`, or `checkups`. All entity IDs are strings in API JSON,
including PostgreSQL's numeric IDs. MongoDB stores string `_id` values and maps
them to `id` in API responses. New MongoDB records receive UUIDs.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | Database connectivity flags; 503 if either check fails |
| GET | `/{database}/stats` | Counts for the four entities |
| GET | `/{database}/{entity}` | Paginated list |
| GET | `/{database}/{entity}/{id}` | Record and first page of related data |
| POST | `/{database}/{entity}` | Create a record; returns it with status 201 |
| PUT | `/{database}/{entity}/{id}` | Update all editable fields; returns the updated record |
| DELETE | `/{database}/{entity}/{id}` | Delete a record; returns `{ "deleted": "id" }` |

## Lists and search

List responses have this structure:

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "limit": 20
}
```

Use `q` for literal, case-insensitive substring search (maximum 200 characters),
`page` for the page number, and `limit` for page size (1–100, default 20).
Search covers names and descriptive fields, including related names on animals
and checkups. It does not interpret regular expressions or SQL wildcards.
Checkups are ordered by examination time descending, then ID descending;
other entities by ID ascending. IDs have different formats between databases, so
their relative order may differ.

Animals accept `enclosureId` and `parentId` filters. Checkups accept `animalId`
and `employeeId` filters. Filters combine with search. For example:

```text
/api/mongo/checkups?animalId=some-id&page=2&limit=20
/api/postgres/animals?q=kito&enclosureId=1
```

Detail responses are `{ "record": {...}, "relations": {...} }`. Relation values
use the same page shape, with a page size of 10:

- Enclosure: `relations.animals`.
- Animal: `relations.checkups` and `relations.offspring`.
- Employee: `relations.checkups`.
- Checkup: no additional relation pages.

Use the filtered list endpoints for subsequent relation pages and complete
history. MongoDB source records also include the embedded arrays documented in
[mongodb-structure.md](mongodb-structure.md); clients should use `relations` and
filtered list endpoints when they need the complete history.

## Creation and editing

POST and PUT use the same complete body format. PUT requires all editable fields;
omitted `parentId` defaults to null. IDs remain unchanged.
Send `Content-Type: application/json`. Unknown fields are rejected. Related IDs
must exist in the selected database. Creation bodies:

```json
{
  "name": "Lion Savannah",
  "habitatType": "Savannah",
  "areaSqm": 2500
}
```

```json
{
  "firstName": "Emma",
  "lastName": "Carter",
  "jobTitle": "Veterinarian",
  "email": "emma.carter@example.com"
}
```

```json
{
  "name": "Kito",
  "birthDate": "2022-06-15",
  "enclosureId": "1",
  "parentId": null
}
```

```json
{
  "animalId": "1",
  "employeeId": "1",
  "checkedAt": "2026-09-04T09:00:00Z",
  "notes": "Routine examination; healthy."
}
```

Habitats: `Savannah`, `Grassland`, `Coastal`, `Tropical rainforest`. Areas must be
positive with at most two decimal places. Names and notes cannot be blank;
employee emails must be valid. Enclosure names and employee emails are unique
within each database. `parentId` is optional and defaults to null. Birth dates use
`YYYY-MM-DD`; examination timestamps require an ISO timestamp with an offset.

MongoDB creates, edits, and deletes update embedded views transactionally.
Animal documents include a derived `children` array of direct-child summaries
(`id`, `name`, `birthDate`), kept in sync through each child's `parentId`.
Renames propagate to embedded summaries, moving an animal updates both enclosure
arrays, and reassigning a checkup refreshes both its former and new owners.
Editing or deleting checkups rebuilds the affected recent-history arrays from the
complete collection, so older records fill gaps while the arrays stay sorted and
limited to 100 entries.

Deleting an animal cascades to **all** of its checkups. Its offspring remain,
with `parent` set to null (PostgreSQL: `parent_id` set to NULL). The animal is
removed from its enclosure's embedded list, and affected employees' recent
checkup arrays are rebuilt from their remaining complete histories. These MongoDB
changes commit in one transaction; PostgreSQL enforces the equivalent behavior
with `ON DELETE CASCADE` and `ON DELETE SET NULL` foreign keys.

DELETE returns 409 if an enclosure still has animals or an employee still has
checkups. Reassign or remove those relationships first. Deleting a checkup removes
its embedded copies and backfills recent-history arrays. No enclosure or employee
is deleted as a consequence of deleting an animal.
Missing IDs return 404 for GET, PUT, and DELETE. Direct self-parenting is rejected;
longer ancestry cycles remain outside this model.

Errors are JSON `{ "error": "..." }`, optionally with
`issues: [{ "field": "...", "message": "..." }]` for form validation.
Statuses: 400 invalid input/references, 404 missing record/route, 405 unsupported
method, 409 duplicate unique value or deletion blocked by dependencies, 415 wrong content type, 503 database failure.
The backend limits request bodies to 64 KiB. PATCH is not supported; use PUT for a complete edit.
