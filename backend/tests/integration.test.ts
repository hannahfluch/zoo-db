import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { connect } from "../src/connections";
import { createHandler } from "../src/api";
import { PostgresStore } from "../src/postgres";
import { MongoStore } from "../src/mongo";
import { entities } from "../src/model";

// Run explicitly against Compose. All writes use a new temporary schema/database.
describe.skipIf(process.env.RUN_INTEGRATION !== "1")("Both persistence adapters", () => {
  let connection: Awaited<ReturnType<typeof connect>>;
  let pool: pg.Pool;
  let mongo: MongoStore;
  let handle: ReturnType<typeof createHandler>;
  const namespace = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    connection = await connect();
    await connection.stores.postgres.pool.query(`CREATE SCHEMA ${namespace}`);
    // pg keeps the password non-enumerable, so an object spread alone loses it.
    pool = new pg.Pool({ ...connection.stores.postgres.pool.options, password: connection.stores.postgres.pool.options.password, options: `-c search_path=${namespace}` });
    await pool.query(await Bun.file(new URL("../../sql/01_schema.sql", import.meta.url)).text());
    mongo = new MongoStore(connection.stores.mongo.client, namespace);
    await mongo.init();
    handle = createHandler({ postgres: new PostgresStore(pool), mongo });
  }, 90000);
  afterAll(async () => {
    if (pool) await pool.end();
    if (connection) {
      await connection.stores.postgres.pool.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      if (mongo) await mongo.db.dropDatabase();
      await connection.close();
    }
  });
  for (const db of ["postgres", "mongo"]) test(`${db}: create, search, detail, constraints and history`, async () => {
    const request = async (path: string, body?: any) => {
      const response = await handle(new Request(`http://api/api/${db}/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}));
      return { status: response.status, data: await response.json() };
    };
    const enclosureInput = { name: "Home [.*%", habitatType: "Savannah", areaSqm: 120.25 };
    const enclosure = await request("enclosures", enclosureInput);
    expect(enclosure.status).toBe(201);
    expect((await request("enclosures", enclosureInput)).status).toBe(409);
    const employee = await request("employees", { firstName: "Emma", lastName: "Carter", jobTitle: "Vet", email: "emma@example.com" });
    expect(employee.status).toBe(201);
    const animal = await request("animals", { name: "Kito", birthDate: "2022-06-15", enclosureId: enclosure.data.id });
    expect(animal.status).toBe(201);
    expect(animal.data.enclosure.name).toBe(enclosureInput.name);
    expect((await request("enclosures?q=" + encodeURIComponent("[.*%"))).data.total).toBe(1);
    expect((await request("animals?q=kItO")).data.total).toBe(1);
    const checkup = { animalId: animal.data.id, employeeId: employee.data.id, checkedAt: "2026-09-04T09:00:00Z", notes: "Healthy" };
    expect((await request("checkups", { ...checkup, employeeId: "missing" })).status).toBe(400);
    expect((await request("stats")).data.checkups).toBe(0);
    expect((await request("checkups", checkup)).status).toBe(201);
    expect((await request(`animals/${animal.data.id}`)).data.relations.checkups.total).toBe(1);
    expect((await request(`employees/${employee.data.id}`)).data.relations.checkups.total).toBe(1);
    expect((await request(`enclosures/${enclosure.data.id}`)).data.relations.animals.total).toBe(1);
    expect((await request("checkups?animalId=missing")).data.total).toBe(0);
    expect((await request("animals?limit=1&page=2")).data.items).toHaveLength(0);
    if (db === "mongo") {
      const enclosed = await mongo.get("enclosures", enclosure.data.id);
      expect(enclosed!.animals[0].id).toBe(animal.data.id);
      // Exercise concurrent transaction retries and the bounded, sorted embedded views.
      for (let offset = 0; offset < 105; offset += 5) await Promise.all(Array.from({ length: 5 }, (_, n) => request("checkups", { ...checkup, checkedAt: new Date(Date.UTC(2026, 8, 5 + offset + n)).toISOString() }).then(result => expect(result.status).toBe(201))));
      const a = await mongo.get("animals", animal.data.id);
      const e = await mongo.get("employees", employee.data.id);
      expect(a!.checkups).toHaveLength(100);
      expect(e!.checkups).toHaveLength(100);
      expect(new Date(a!.checkups[0].checkedAt).getTime()).toBeGreaterThan(new Date(a!.checkups[99].checkedAt).getTime());
      expect((await request(`checkups?animalId=${animal.data.id}&page=2&limit=100`)).data.items).toHaveLength(6);
      const removeResponse = await handle(new Request(`http://api/api/mongo/checkups/${a!.checkups[0].id}`, { method: "DELETE" }));
      expect(removeResponse.status).toBe(200);
      const expected = (await request(`checkups?animalId=${animal.data.id}&limit=100`)).data.items.map((c: any) => c.id);
      expect((await mongo.get("animals", animal.data.id))!.checkups.map((c: any) => c.id)).toEqual(expected);
      expect((await mongo.get("employees", employee.data.id))!.checkups.map((c: any) => c.id)).toEqual(expected);
      for (const entity of entities) expect((await request(entity)).status).toBe(200);
    }
  }, 90000);
  for (const db of ["postgres", "mongo"]) test(`${db}: edit, propagate embedded copies, reassign and delete`, async () => {
    const request = async (path: string, body?: any, method = body ? "POST" : "GET") => {
      const response = await handle(new Request(`http://api/api/${db}/${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }));
      return { status: response.status, data: await response.json() };
    };
    const make = async (entity: string, body: any) => { const result = await request(entity, body); expect(result.status).toBe(201); return result.data.id; };
    const read = async (entity: string, id: string) => (await request(`${entity}/${id}`)).data.record;
    const put = (entity: string, id: string, body: any) => request(`${entity}/${id}`, body, "PUT");
    const remove = (entity: string, id: string) => request(`${entity}/${id}`, undefined, "DELETE");
    const area = { name: "Edit enclosure A", habitatType: "Savannah", areaSqm: 100 };
    const homeA = await make("enclosures", area);
    const homeB = await make("enclosures", { ...area, name: "Edit enclosure B" });
    const person = { firstName: "Test", lastName: "Vet", jobTitle: "Vet", email: "edit-a@example.com" };
    const vetA = await make("employees", person);
    const vetB = await make("employees", { ...person, email: "edit-b@example.com" });
    const animal = { name: "Parent", birthDate: "2020-01-01", enclosureId: homeA, parentId: null };
    const parent = await make("animals", animal);
    const child = await make("animals", { ...animal, name: "Child", parentId: parent });
    const checkup = { animalId: parent, employeeId: vetA, checkedAt: "2026-09-04T09:00:00Z", notes: "Original" };
    const examination = await make("checkups", checkup);
    expect((await put("enclosures", homeA, { ...area, name: "Edit enclosure B" })).status).toBe(409);
    expect((await put("employees", vetA, { ...person, email: "edit-b@example.com" })).status).toBe(409);
    expect((await put("animals", parent, { ...animal, parentId: parent })).status).toBe(400);
    expect((await put("animals", parent, { ...animal, enclosureId: "missing" })).status).toBe(400);
    expect((await read("animals", parent)).name).toBe("Parent");
    expect((await put("animals", parent, { ...animal, name: "Renamed", birthDate: "2019-02-03", enclosureId: homeB })).status).toBe(200);
    expect((await read("animals", child)).parent.name).toBe("Renamed");
    expect((await read("checkups", examination)).animal.name).toBe("Renamed");
    expect((await put("enclosures", homeB, { ...area, name: "Updated home", areaSqm: 250 })).status).toBe(200);
    expect((await read("animals", parent)).enclosure.name).toBe("Updated home");
    expect((await put("employees", vetA, { ...person, firstName: "Updated", lastName: "Doctor" })).status).toBe(200);
    expect((await read("checkups", examination)).employee.firstName).toBe("Updated");
    if (db === "mongo") {
      expect((await read("enclosures", homeA)).animals.map((a: any) => a.id)).toEqual([child]);
      expect((await read("enclosures", homeB)).animals[0]).toMatchObject({ id: parent, name: "Renamed", birthDate: "2019-02-03" });
      expect((await read("employees", vetA)).checkups[0].animal.name).toBe("Renamed");
      expect((await read("animals", parent)).checkups[0].employee.lastName).toBe("Doctor");
    }
    expect((await put("checkups", examination, { ...checkup, animalId: child, employeeId: "missing", notes: "Must roll back" })).status).toBe(400);
    expect((await read("checkups", examination)).notes).toBe("Original");
    expect((await put("checkups", examination, { ...checkup, animalId: child, employeeId: vetB, checkedAt: "2026-10-01T10:30:00Z", notes: "Updated notes" })).status).toBe(200);
    expect((await read("checkups", examination)).animal.id).toBe(child);
    if (db === "mongo") {
      expect((await read("animals", parent)).checkups).toHaveLength(0);
      expect((await read("employees", vetA)).checkups).toHaveLength(0);
      expect((await read("animals", child)).checkups[0]).toMatchObject({ id: examination, notes: "Updated notes", employee: { id: vetB } });
      expect((await read("employees", vetB)).checkups[0].animal.id).toBe(child);
    }
    expect((await remove("enclosures", homeB)).status).toBe(409);
    expect((await remove("employees", vetB)).status).toBe(409);
    expect((await remove("checkups", examination)).status).toBe(200);
    if (db === "mongo") {
      expect((await read("animals", child)).checkups).toHaveLength(0);
      expect((await read("employees", vetB)).checkups).toHaveLength(0);
    }
    expect((await put("animals", child, { ...animal, name: "Child", parentId: null })).status).toBe(200);
    for (const [entity, id] of [["animals", parent], ["animals", child], ["employees", vetA], ["employees", vetB], ["enclosures", homeA], ["enclosures", homeB]]) {
      expect((await remove(entity, id)).status).toBe(200);
      expect((await request(`${entity}/${id}`)).status).toBe(404);
      expect((await remove(entity, id)).status).toBe(404);
    }
    expect((await put("enclosures", "missing", area)).status).toBe(404);
  }, 90000);
  test("mongo: embedded children follow creation, edits, reparenting and deletion", async () => {
    const request = async (path: string, body?: any, method = body ? "POST" : "GET") => {
      const response = await handle(new Request(`http://api/api/mongo/${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }));
      return { status: response.status, data: await response.json() };
    };
    const home = await mongo.create("enclosures", { name: "Children home", habitatType: "Savannah", areaSqm: 200 });
    const input = { name: "Parent A", birthDate: "2020-01-01", enclosureId: home.id, parentId: null };
    const make = async (body: any) => { const result = await request("animals", body); expect(result.status).toBe(201); return result.data; };
    const put = async (id: string, body: any) => { const result = await request(`animals/${id}`, body, "PUT"); expect(result.status).toBe(200); return result.data; };
    const children = async (id: string) => (await mongo.collection("animals").findOne({ _id: id }))!.children;
    const parentA = await make(input);
    const parentB = await make({ ...input, name: "Parent B" });
    expect(parentA.children).toEqual([]);
    const [child, sibling] = await Promise.all([
      make({ ...input, name: "Child", parentId: parentA.id }),
      make({ ...input, name: "Sibling", parentId: parentA.id }),
    ]);
    const grandchild = await make({ ...input, name: "Grandchild", parentId: child.id });
    expect((await children(parentA.id)).map((c: any) => c.id).sort()).toEqual([child.id, sibling.id].sort());
    expect(await children(child.id)).toEqual([{ id: grandchild.id, name: "Grandchild", birthDate: input.birthDate }]);
    // Embedded summaries must not recursively contain a child's own children.
    expect((await children(parentA.id)).find((c: any) => c.id === child.id)).toEqual({ id: child.id, name: "Child", birthDate: input.birthDate });
    const edited = { ...input, name: "Renamed child", birthDate: "2021-02-03", parentId: parentA.id };
    await put(child.id, edited);
    await put(child.id, edited);
    expect((await children(parentA.id)).filter((c: any) => c.id === child.id)).toEqual([{ id: child.id, name: edited.name, birthDate: edited.birthDate }]);
    expect((await mongo.get("animals", grandchild.id))!.parent.name).toBe(edited.name);
    expect((await request(`animals/${child.id}`, { ...edited, parentId: "missing" }, "PUT")).status).toBe(400);
    expect((await children(parentA.id))).toHaveLength(2);
    expect((await request(`animals/${child.id}`, { ...edited, children: [] }, "PUT")).status).toBe(400);
    await put(child.id, { ...edited, parentId: parentB.id });
    expect((await children(parentA.id)).map((c: any) => c.id)).toEqual([sibling.id]);
    expect((await children(parentB.id)).map((c: any) => c.id)).toEqual([child.id]);
    expect((await request(`animals/${parentB.id}`)).data.record.children[0].name).toBe(edited.name);
    await put(child.id, { ...edited, parentId: null });
    expect(await children(parentB.id)).toEqual([]);
    await put(child.id, edited);
    expect((await request(`animals/${child.id}`, undefined, "DELETE")).status).toBe(200);
    expect((await children(parentA.id)).map((c: any) => c.id)).toEqual([sibling.id]);
    expect((await mongo.get("animals", grandchild.id))!.parent).toBeNull();
    expect(await children(grandchild.id)).toEqual([]);
    expect((await request(`animals/${parentA.id}`, undefined, "DELETE")).status).toBe(200);
    expect((await mongo.get("animals", sibling.id))!.parent).toBeNull();
  });
  test("mongo: PostgreSQL import embeds direct children", async () => {
    const postgres = new PostgresStore(pool);
    const home = await postgres.create("enclosures", { name: "Seed children home", habitatType: "Savannah", areaSqm: 200 });
    const input = { name: "Seed child", birthDate: "2020-01-01", enclosureId: home.id, parentId: null };
    // The parent appears after its child in source ID order.
    const child = await postgres.create("animals", input);
    const parent = await postgres.create("animals", { ...input, name: "Seed parent" });
    await postgres.update("animals", child.id, { ...input, parentId: parent.id });
    const database = `${namespace}_seed`;
    try {
      const process = Bun.spawn(["bun", new URL("../src/seed-mongo.ts", import.meta.url).pathname], {
        env: { ...Bun.env, PGOPTIONS: `-c search_path=${namespace}`, MONGO_DATABASE: database },
        stdout: "pipe", stderr: "pipe",
      });
      const [, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const seeded = new MongoStore(connection.stores.mongo.client, database);
      expect((await seeded.get("animals", parent.id))!.children).toEqual([{ id: child.id, name: input.name, birthDate: input.birthDate }]);
      expect((await seeded.get("animals", child.id))!.children).toEqual([]);
    } finally { await connection.stores.mongo.client.db(database).dropDatabase(); }
  }, 30000);
  for (const db of ["postgres", "mongo"]) test(`${db}: animal deletion cascades through full history and preserves offspring`, async () => {
    const request = async (path: string, body?: any, method = body ? "POST" : "GET") => {
      const response = await handle(new Request(`http://api/api/${db}/${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }));
      return { status: response.status, data: await response.json() };
    };
    const make = async (entity: string, body: any) => { const result = await request(entity, body); expect(result.status).toBe(201); return result.data.id; };
    const home = await make("enclosures", { name: "Cascade home", habitatType: "Savannah", areaSqm: 200 });
    const person = { firstName: "Cascade", lastName: "Vet", jobTitle: "Vet" };
    const vetA = await make("employees", { ...person, email: "cascade-a@example.com" });
    const vetB = await make("employees", { ...person, email: "cascade-b@example.com" });
    const animal = { name: "Cascade target", birthDate: "2020-01-01", enclosureId: home };
    const target = await make("animals", animal);
    const survivor = await make("animals", { ...animal, name: "Unrelated survivor" });
    const child = await make("animals", { ...animal, name: "Surviving offspring", parentId: target });
    const checkup = { employeeId: vetA, notes: "Cascade test" };
    // More than 100 examinations ensures both deletion and history backfilling
    // use the full collection, not just the embedded recent-history arrays.
    for (let day = 1; day <= 101; day++) {
      await make("checkups", { ...checkup, animalId: survivor, checkedAt: new Date(Date.UTC(2025, 0, day)).toISOString() });
      await make("checkups", { ...checkup, animalId: target, checkedAt: new Date(Date.UTC(2026, 0, day)).toISOString() });
    }
    const hiddenCheckup = await make("checkups", { ...checkup, employeeId: vetB, animalId: target, checkedAt: "2024-01-01T00:00:00Z" });
    const retainedCheckup = await make("checkups", { ...checkup, employeeId: vetB, animalId: survivor, checkedAt: "2023-01-01T00:00:00Z" });
    const childCheckup = await make("checkups", { ...checkup, animalId: child, checkedAt: "2027-01-01T00:00:00Z" });
    const before = (await request("stats")).data;
    if (db === "mongo") {
      expect((await mongo.get("animals", target))!.checkups).toHaveLength(100);
      expect((await mongo.get("animals", target))!.checkups.some((c: any) => c.id === hiddenCheckup)).toBe(false);
    }
    expect((await request(`animals/${target}`, undefined, "DELETE")).status).toBe(200);
    expect((await request(`animals/${target}`)).status).toBe(404);
    expect((await request(`checkups?animalId=${target}`)).data.total).toBe(0);
    expect((await request(`checkups/${hiddenCheckup}`)).status).toBe(404);
    expect((await request(`animals/${child}`)).data.record.parent).toBeNull();
    expect((await request(`checkups/${childCheckup}`)).status).toBe(200);
    expect((await request(`checkups/${retainedCheckup}`)).status).toBe(200);
    expect((await request(`animals/${survivor}`)).status).toBe(200);
    const after = (await request("stats")).data;
    expect(after.animals).toBe(before.animals - 1);
    expect(after.checkups).toBe(before.checkups - 102);
    expect(after.employees).toBe(before.employees);
    expect(after.enclosures).toBe(before.enclosures);
    expect((await request(`enclosures/${home}`, undefined, "DELETE")).status).toBe(409);
    expect((await request(`employees/${vetA}`, undefined, "DELETE")).status).toBe(409);
    if (db === "mongo") {
      expect((await mongo.get("enclosures", home))!.animals.map((a: any) => a.id).sort()).toEqual([survivor, child].sort());
      for (const vet of [vetA, vetB]) {
        const expected = (await request(`checkups?employeeId=${vet}&limit=100`)).data.items.map((c: any) => c.id);
        const embedded = (await mongo.get("employees", vet))!.checkups;
        expect(embedded.map((c: any) => c.id)).toEqual(expected);
        expect(embedded.every((c: any) => c.animal.id !== target)).toBe(true);
      }
      expect((await mongo.get("employees", vetA))!.checkups).toHaveLength(100);
      expect((await mongo.get("employees", vetB))!.checkups).toHaveLength(1);
    }
    expect((await request(`animals/${target}`, undefined, "DELETE")).status).toBe(404);
  }, 90000);
});
