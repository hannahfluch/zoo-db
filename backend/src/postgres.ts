import pg from "pg";
import { entities, HttpError, searchFields, type Entity, type Input, type ListOptions, type RecordData, type Store } from "./model";

// These SQL fragments are fixed application constants; user values are parameters.
const selects: Record<Entity, string> = {
  enclosures: `SELECT e.enclosure_id::text AS id, e.name, e.habitat_type AS "habitatType", e.area_sqm::float8 AS "areaSqm" FROM enclosures e`,
  employees: `SELECT e.employee_id::text AS id, e.first_name AS "firstName", e.last_name AS "lastName", e.job_title AS "jobTitle", e.email FROM employees e`,
  animals: `SELECT a.animal_id::text AS id, a.name, to_char(a.birth_date, 'YYYY-MM-DD') AS "birthDate", json_build_object('id', e.enclosure_id::text, 'name', e.name) AS enclosure, CASE WHEN p.animal_id IS NULL THEN NULL ELSE json_build_object('id', p.animal_id::text, 'name', p.name) END AS parent FROM animals a JOIN enclosures e USING (enclosure_id) LEFT JOIN animals p ON p.animal_id = a.parent_id`,
  checkups: `SELECT c.checkup_id::text AS id, c.checked_at AS "checkedAt", c.notes, json_build_object('id', a.animal_id::text, 'name', a.name) AS animal, json_build_object('id', e.employee_id::text, 'firstName', e.first_name, 'lastName', e.last_name) AS employee FROM checkups c JOIN animals a USING (animal_id) JOIN employees e USING (employee_id)`,
};
const columns: Record<Entity, Record<string, string>> = {
  enclosures: { name: "name", habitatType: "habitat_type", areaSqm: "area_sqm" },
  employees: { firstName: "first_name", lastName: "last_name", jobTitle: "job_title", email: "email" },
  animals: { name: "name", birthDate: "birth_date", enclosureId: "enclosure_id", parentId: "parent_id" },
  checkups: { animalId: "animal_id", employeeId: "employee_id", checkedAt: "checked_at", notes: "notes" },
};
const primary: Record<Entity, string> = { enclosures: "enclosure_id", employees: "employee_id", animals: "animal_id", checkups: "checkup_id" };
export class PostgresStore implements Store {
  constructor(public pool: pg.Pool) {}
  async ping() { await this.pool.query("SELECT 1"); }
  async stats() {
    const counts = await Promise.all(entities.map(async e => [e, Number((await this.pool.query(`SELECT count(*) FROM ${e}`)).rows[0].count)]));
    return Object.fromEntries(counts) as Record<Entity, number>;
  }
  async list(entity: Entity, options: ListOptions) {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (options.q) {
      values.push(options.q);
      conditions.push(`(${searchFields[entity].map(field => {
        const [name, nested] = field.split(".");
        const expression = nested ? `r."${name}"->>'${nested}'` : `r."${name}"::text`;
        return `strpos(lower(${expression}), lower($${values.length})) > 0`;
      }).join(" OR ")})`);
    }
    const filters = entity === "checkups" ? { animalId: "animal", employeeId: "employee" } : entity === "animals" ? { enclosureId: "enclosure", parentId: "parent" } : {};
    for (const [key, field] of Object.entries(filters)) {
      const value = options[key as keyof ListOptions];
      if (value) { values.push(value); conditions.push(`r."${field}"->>'id' = $${values.length}`); }
    }
    const base = `FROM (${selects[entity]}) r${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`;
    const total = Number((await this.pool.query(`SELECT count(*) ${base}`, values)).rows[0].count);
    const order = entity === "checkups" ? `r."checkedAt" DESC, r.id::integer DESC` : `r.id::integer ASC`;
    const items = (await this.pool.query(`SELECT r.* ${base} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, options.limit, (options.page - 1) * options.limit])).rows;
    return { items, total, page: options.page, limit: options.limit };
  }
  async get(entity: Entity, id: string): Promise<RecordData | null> {
    return (await this.pool.query(`SELECT * FROM (${selects[entity]}) r WHERE r.id = $1`, [id])).rows[0] || null;
  }
  async create(entity: Entity, input: Input) {
    try {
      const fields = Object.entries(columns[entity]);
      const result = await this.pool.query(`INSERT INTO ${entity} (${fields.map(([, column]) => column).join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")}) RETURNING ${primary[entity]} AS id`, fields.map(([field]) => input[field]));
      return (await this.get(entity, String(result.rows[0].id)))!;
    } catch (error: any) {
      if (error.code === "23505") throw new HttpError(409, "An enclosure with that name or an employee with that email already exists.");
      if (["23503", "22P02", "22003", "22007", "22008", "23514"].includes(error.code)) throw new HttpError(400, "Invalid field value or related record does not exist.");
      throw error;
    }
  }
  async update(entity: Entity, id: string, input: Input) {
    try {
      const fields = Object.entries(columns[entity]);
      const result = await this.pool.query(`UPDATE ${entity} SET ${fields.map(([, column], i) => `${column} = $${i + 1}`).join(",")} WHERE ${primary[entity]}::text = $${fields.length + 1} RETURNING ${primary[entity]}`, [...fields.map(([field]) => input[field]), id]);
      if (!result.rowCount) throw new HttpError(404, "Record not found");
      return (await this.get(entity, id))!;
    } catch (error: any) {
      if (error.code === "23505") throw new HttpError(409, "An enclosure with that name or an employee with that email already exists.");
      if (["23503", "22P02", "22003", "22007", "22008", "23514"].includes(error.code)) throw new HttpError(400, "Invalid field value or related record does not exist.");
      throw error;
    }
  }
  async delete(entity: Entity, id: string) {
    try {
      const result = await this.pool.query(`DELETE FROM ${entity} WHERE ${primary[entity]}::text = $1`, [id]);
      if (!result.rowCount) throw new HttpError(404, "Record not found");
    } catch (error: any) {
      if (error.code === "23503") throw new HttpError(409, "This record is still referenced. Remove or reassign its related records first.");
      throw error;
    }
  }
}
