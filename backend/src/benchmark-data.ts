import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { MongoStore } from "./mongo";
import { entities, habitats, type Entity } from "./model";

export function generateBatch(count: number, seed: number, run: string = randomUUID()) {
  let state = seed >>> 0;
  const random = () => { state += 0x6D2B79F5; let n = Math.imul(state ^ state >>> 15, 1 | state); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const enclosures = Array.from({ length: count }, (_, i) => ({ name: `Enclosure ${run}-${i}`, habitatType: pick(habitats), areaSqm: Math.round((100 + random() * 9900) * 100) / 100 }));
  const employees = Array.from({ length: count }, (_, i) => ({ firstName: pick(["Emma", "Noah", "Olivia", "Liam", "Mia", "Leo"]), lastName: pick(["Carter", "Reed", "Brooks", "Parker"]), jobTitle: pick(["Veterinarian", "Veterinary nurse", "Zookeeper"]), email: `${run}-${i}@zoo.example` }));
  const animals = Array.from({ length: count }, (_, i) => ({ name: `${pick(["Nala", "Kito", "Milo", "Rio"])} ${run}-${i}`, birthDate: `${i % 10 ? "2020" : "2010"}-${String(1 + Math.floor(random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`, enclosureIndex: Math.floor(random() * count), parentIndex: i % 10 ? i - i % 10 : null }));
  const checkups = Array.from({ length: count }, (_, i) => ({ animalIndex: Math.floor(random() * count), employeeIndex: Math.floor(random() * count), checkedAt: new Date(Date.UTC(2024, 0, 1) + Math.floor(random() * (Date.UTC(2027, 0, 1) - Date.UTC(2024, 0, 1)))).toISOString(), notes: `${pick(["Routine examination", "Follow-up", "Dental examination"])} ${run}-${i}` }));
  return { count, seed, run, enclosures, employees, animals, checkups };
}
export type Batch = ReturnType<typeof generateBatch>;
type Ids = Record<Entity, string[]>;
export const batchIds = (batch: Batch): Ids => Object.fromEntries(entities.map(entity => [entity, Array.from({ length: batch.count }, (_, i) => `${batch.run}-${entity}-${i}`)])) as Ids;

export async function insertPostgres(pool: pg.Pool, batch: Batch, progress: (stage: string) => void, commit = true, recordDatabaseMs?: (ms: number) => void): Promise<Ids> {
  const client = await pool.connect();
  const ids = batchIds(batch);
  let databaseMs = 0;
  const execute = async (text: string, values: unknown[]) => {
    const started = performance.now();
    try { return await client.query(text, values); }
    finally { databaseMs += performance.now() - started; }
  };
  const insert = async (entity: Entity, records: any[], definition: string, columns: string, select: string, identity: string, key: string) => {
    const positions = new Map(records.map((record, i) => [record[key], i]));
    for (let offset = 0; offset < records.length; offset += 1000) {
      const result = await execute(`INSERT INTO ${entity} (${columns}) SELECT ${select} FROM jsonb_to_recordset($1::jsonb) AS x(${definition}) RETURNING ${identity}::text AS id, ${key}`, [JSON.stringify(records.slice(offset, offset + 1000))]);
      for (const row of result.rows) ids[entity][positions.get(row[key])!] = row.id;
      progress(`PostgreSQL: ${entity} ${Math.min(offset + 1000, records.length)}/${records.length}`);
    }
  };
  try {
    await client.query("BEGIN");
    await insert("enclosures", batch.enclosures.map(e => ({ name: e.name, habitat_type: e.habitatType, area_sqm: e.areaSqm })), "name text, habitat_type text, area_sqm numeric", "name,habitat_type,area_sqm", "name,habitat_type::enclosure_type,area_sqm", "enclosure_id", "name");
    await insert("employees", batch.employees.map(e => ({ first_name: e.firstName, last_name: e.lastName, job_title: e.jobTitle, email: e.email })), "first_name text,last_name text,job_title text,email text", "first_name,last_name,job_title,email", "first_name,last_name,job_title,email", "employee_id", "email");
    await insert("animals", batch.animals.map(a => ({ name: a.name, birth_date: a.birthDate, enclosure_id: Number(ids.enclosures[a.enclosureIndex]) })), "name text,birth_date date,enclosure_id integer", "name,birth_date,enclosure_id", "name,birth_date,enclosure_id", "animal_id", "name");
    const parents = batch.animals.flatMap((a, i) => a.parentIndex === null ? [] : [{ id: Number(ids.animals[i]), parent: Number(ids.animals[a.parentIndex]) }]);
    for (let offset = 0; offset < parents.length; offset += 1000) await execute("UPDATE animals a SET parent_id = x.parent FROM jsonb_to_recordset($1::jsonb) AS x(id integer,parent integer) WHERE a.animal_id = x.id", [JSON.stringify(parents.slice(offset, offset + 1000))]);
    await insert("checkups", batch.checkups.map(c => ({ animal_id: Number(ids.animals[c.animalIndex]), employee_id: Number(ids.employees[c.employeeIndex]), checked_at: c.checkedAt, notes: c.notes })), "animal_id integer,employee_id integer,checked_at timestamptz,notes text", "animal_id,employee_id,checked_at,notes", "animal_id,employee_id,checked_at,notes", "checkup_id", "notes");
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return ids;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); recordDatabaseMs?.(databaseMs); }
}

class InsertRollback extends Error {}

export async function insertMongo(store: MongoStore, batch: Batch, ids: Ids, progress: (stage: string) => void, commit = true, recordDatabaseMs?: (ms: number) => void) {
  const docs: Record<Entity, any[]> = {
    enclosures: batch.enclosures.map((e, i) => ({ _id: ids.enclosures[i], ...e, animals: [] })),
    employees: batch.employees.map((e, i) => ({ _id: ids.employees[i], ...e, checkups: [] })),
    animals: batch.animals.map((a, i) => ({ _id: ids.animals[i], name: a.name, birthDate: a.birthDate, enclosure: { id: ids.enclosures[a.enclosureIndex], name: batch.enclosures[a.enclosureIndex].name }, parent: a.parentIndex === null ? null : { id: ids.animals[a.parentIndex], name: batch.animals[a.parentIndex].name }, children: [], checkups: [] })),
    checkups: batch.checkups.map((c, i) => ({ _id: ids.checkups[i], checkedAt: new Date(c.checkedAt), notes: c.notes, animal: { id: ids.animals[c.animalIndex], name: batch.animals[c.animalIndex].name }, employee: { id: ids.employees[c.employeeIndex], firstName: batch.employees[c.employeeIndex].firstName, lastName: batch.employees[c.employeeIndex].lastName } })),
  };
  for (let i = 0; i < batch.count; i++) {
    const a = batch.animals[i];
    const summary = { id: ids.animals[i], name: a.name, birthDate: a.birthDate };
    docs.enclosures[a.enclosureIndex].animals.push(summary);
    if (a.parentIndex !== null) docs.animals[a.parentIndex].children.push(summary);
  }
  const ordered = docs.checkups.map((c, i) => ({ c, i })).sort((a, b) => b.c.checkedAt.getTime() - a.c.checkedAt.getTime() || (a.c._id < b.c._id ? 1 : a.c._id > b.c._id ? -1 : 0));
  for (const { c, i } of ordered) {
    const source = batch.checkups[i];
    const common = { id: c._id, checkedAt: c.checkedAt, notes: c.notes };
    if (docs.animals[source.animalIndex].checkups.length < 100) docs.animals[source.animalIndex].checkups.push({ ...common, employee: c.employee });
    if (docs.employees[source.employeeIndex].checkups.length < 100) docs.employees[source.employeeIndex].checkups.push({ ...common, animal: c.animal });
  }
  const session = store.client.startSession();
  let databaseMs = 0;
  try {
    await session.withTransaction(async () => {
      for (const entity of entities) for (let offset = 0; offset < batch.count; offset += 1000) {
        const started = performance.now();
        try { await store.collection(entity).insertMany(docs[entity].slice(offset, offset + 1000), { session }); }
        finally { databaseMs += performance.now() - started; }
        progress(`MongoDB: ${entity} ${Math.min(offset + 1000, batch.count)}/${batch.count}`);
      }
      if (!commit) throw new InsertRollback("Benchmark insert rolled back");
    });
  } catch (error) { if (!(error instanceof InsertRollback)) throw error; }
  finally { await session.endSession(); recordDatabaseMs?.(databaseMs); }
}
