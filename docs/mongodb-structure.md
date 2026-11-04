# MongoDB document structure

This document specifies the planned MongoDB persistence variant. It is a design;
the repository does not yet implement MongoDB persistence or scalable seeding.

Keep the four collections `enclosures`, `employees`, `animals`, and `checkups`.
Each holds the authoritative records for its entity. Embed related summaries to
let the frontend render detail pages without joining collections. Embedded IDs
identify the source records; the other embedded fields are duplicated data.

The examples use string IDs and ISO date strings as a JSON file format. An
implementation must use the same ID representation throughout and convert
`checkedAt` values to BSON dates when importing. `birthDate` remains a date-only
string (`YYYY-MM-DD`).

## Enclosures

The enclosure detail page receives enclosure information and its animal list.
Embedded animals contain only the fields needed by that list.

```json
{
  "_id": "enclosure-1",
  "name": "Lion Savannah",
  "habitatType": "Savannah",
  "areaSqm": 2500,
  "animals": [
    {
      "id": "animal-4",
      "name": "Kito",
      "birthDate": "2022-06-15"
    }
  ]
}
```

## Employees

The employee detail page receives employee information and recent checkups,
including the animal name for each examination.

```json
{
  "_id": "employee-1",
  "firstName": "Emma",
  "lastName": "Carter",
  "jobTitle": "Veterinarian",
  "email": "emma.carter@example.com",
  "checkups": [
    {
      "id": "checkup-4",
      "checkedAt": "2026-09-04T09:00:00Z",
      "notes": "Minor paw irritation; follow-up scheduled.",
      "animal": { "id": "animal-4", "name": "Kito" }
    }
  ]
}
```

## Animals

The animal detail page receives animal information, an enclosure summary, an
optional parent summary, and recent checkups with employee names.

```json
{
  "_id": "animal-4",
  "name": "Kito",
  "birthDate": "2022-06-15",
  "enclosure": { "id": "enclosure-1", "name": "Lion Savannah" },
  "parent": { "id": "animal-1", "name": "Nala" },
  "checkups": [
    {
      "id": "checkup-4",
      "checkedAt": "2026-09-04T09:00:00Z",
      "notes": "Minor paw irritation; follow-up scheduled.",
      "employee": {
        "id": "employee-1",
        "firstName": "Emma",
        "lastName": "Carter"
      }
    }
  ]
}
```

Use `parent: null` when no parent is recorded. Use empty arrays when no related
records exist. Do not recursively embed parents, enclosures, or complete animal
and employee documents inside their summaries.

## Checkups

This collection stores the complete examination history. Each document embeds
animal and employee summaries so the checkup list can display their names.
The animal–employee many-to-many relationship remains represented by checkups:
an animal can be examined by multiple employees, and an employee can examine
multiple animals. The same pair can have multiple examinations.

```json
{
  "_id": "checkup-4",
  "checkedAt": "2026-09-04T09:00:00Z",
  "notes": "Minor paw irritation; follow-up scheduled.",
  "animal": { "id": "animal-4", "name": "Kito" },
  "employee": {
    "id": "employee-1",
    "firstName": "Emma",
    "lastName": "Carter"
  }
}
```

## Array growth and history

Keep only the latest 100 checkups in each animal and employee document, ordered
by `checkedAt` descending and then by checkup ID for deterministic ties. These
arrays are frontend views, not the complete history. Fetch older entries from
`checkups`, filtered by `animal.id` or `employee.id`, with pagination. If an edit
or deletion changes the latest 100, rebuild the affected arrays from that
collection so older entries can fill the gap.

The enclosure animal array represents its current occupants. Scale test data
across enclosures as well as animals and employees; do not place every generated
animal in one enclosure. If real enclosure populations outgrow a practical
document size, that view will also need a bounded summary and a paginated query
against `animals.enclosure.id`.

## Keeping embedded copies consistent

Embedded values represent current data, not historical snapshots.

- Creating a checkup inserts its authoritative document and refreshes the recent
  checkup arrays of the affected animal and employee.
- Editing or deleting a checkup refreshes the affected embedded copies. If its
  animal or employee changes, refresh both the old and new owners.
- Creating an animal adds its summary to its enclosure. Moving it updates its
  enclosure summary and both enclosures' animal arrays.
- Renaming an animal updates its enclosure entry, parent summaries in offspring,
  animal summaries in checkups, and employee checkup arrays containing it.
- Renaming an employee updates employee summaries in checkups and animal checkup
  arrays. Renaming an enclosure updates enclosure summaries in its animals.
- Changes to other duplicated fields, such as animal birth dates, propagate to
  every embedded copy of that field.
- Preserve the relational model's deletion restrictions: reject deleting an
  enclosure with animals, an animal with offspring or checkups, or an employee
  with checkups. Deleting an otherwise eligible animal removes its enclosure entry.

The persistence implementation must coordinate these multi-document changes,
using transactions when atomic consistency is required. Enforce required fields,
allowed habitat types, positive areas, nonempty notes, and unique enclosure names
and employee emails as in the relational variant. Relationship validity must
also be checked by the persistence layer.

## Scalable seed and write tests

A future generator should accept a test-case count from 10 to 100,000, create
valid related records, and derive every embedded view from the same source data.
Store each entity once in its authoritative collection and copy summaries into
the appropriate views. Seed output can use four JSON files named after the
collections, each containing an array of documents.

For benchmark reporting, distinguish a logical operation (for example, creating
one checkup) from its database writes (the checkup insert and updates to two
embedded views). Include those updates in measured work. Record the operation
mix, dataset sizes, completed cases, failures, and elapsed time so the MongoDB
and relational results can be compared on the same workload.
