import { describe, expect, test } from "bun:test";
import { createHandler } from "../src/api";
import { parseList, schemas, type Store } from "../src/model";

const store: Store = {
  async ping() {},
  async stats() { return { animals: 0, employees: 0, enclosures: 0, checkups: 0 }; },
  async get() { return null; },
  async create() { throw new Error("Invalid input must not reach storage"); },
  async update() { throw new Error("Invalid input must not reach storage"); },
  async delete() { throw new Error("Unsupported methods must not reach storage"); },
  async list(_, options) { return { items: [], total: 0, ...options }; },
};
const handle = createHandler({ postgres: store, mongo: store });
describe("API validation", () => {
  test("rejects invalid calendar dates and unknown fields", () => {
    expect(schemas.animals.safeParse({ name: "Kito", birthDate: "2026-02-30", enclosureId: "1" }).success).toBe(false);
    expect(schemas.employees.safeParse({ firstName: "A", lastName: "B", jobTitle: "Vet", email: "a@example.com", extra: true }).success).toBe(false);
  });
  test("requires positive area with two decimal places and nonempty notes", () => {
    expect(schemas.enclosures.safeParse({ name: "Home", habitatType: "Savannah", areaSqm: 1.001 }).success).toBe(false);
    expect(schemas.checkups.safeParse({ animalId: "1", employeeId: "1", checkedAt: "2026-09-04T09:00:00Z", notes: "   " }).success).toBe(false);
  });
  test("bounds pagination and accepts literal search terms", () => {
    expect(() => parseList(new URLSearchParams("limit=101"))).toThrow();
    expect(() => parseList(new URLSearchParams("page=-1"))).toThrow();
    expect(parseList(new URLSearchParams({ q: "[.*%" })).q).toBe("[.*%");
  });
  test("returns useful JSON validation errors before writing", async () => {
    const response = await handle(new Request("http://api/api/mongo/animals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "" }) }));
    expect(response.status).toBe(400);
    expect((await response.json()).issues.length).toBeGreaterThan(0);
  });
  test("returns 404 for missing records, 405 for unsupported writes", async () => {
    expect((await handle(new Request("http://api/api/postgres/animals/missing"))).status).toBe(404);
    expect((await handle(new Request("http://api/api/mongo/animals/1", { method: "PATCH" }))).status).toBe(405);
    expect((await handle(new Request("http://api/api/unknown/animals"))).status).toBe(404);
  });
});
