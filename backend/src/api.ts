import { ZodError } from "zod";
import { entities, HttpError, parseList, schemas, type Entity, type Store } from "./model";

export function createHandler(stores: { postgres: Store; mongo: Store }) {
  return async (request: Request): Promise<Response> => {
    const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
        const results = await Promise.allSettled([stores.postgres.ping(), stores.mongo.ping()]);
        return reply({ postgres: results[0].status === "fulfilled", mongo: results[1].status === "fulfilled" }, results.every(r => r.status === "fulfilled") ? 200 : 503);
      }
      const match = url.pathname.match(/^\/api\/(postgres|mongo)\/(enclosures|employees|animals|checkups|stats)(?:\/([^/]+))?\/?$/);
      if (!match) throw new HttpError(404, "API route not found");
      const store = stores[match[1] as "postgres" | "mongo"];
      if (match[2] === "stats") {
        if (match[3]) throw new HttpError(404, "API route not found");
        if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
        return reply(await store.stats());
      }
      const entity = match[2] as Entity;
      const id = match[3] ? decodeURIComponent(match[3]) : null;
      if (id && id.length > 100) throw new HttpError(400, "Invalid ID");
      if (request.method === "GET") {
        if (!match[3]) return reply(await store.list(entity, parseList(url.searchParams)));
        const id = decodeURIComponent(match[3]);
        if (id.length > 100) throw new HttpError(400, "Invalid ID");
        const record = await store.get(entity, id);
        if (!record) throw new HttpError(404, "Record not found");
        const relations: Record<string, unknown> = {};
        const options = { q: "", page: 1, limit: 10 };
        // Full history is paginated independently from the bounded embedded arrays.
        if (entity === "enclosures") relations.animals = await store.list("animals", { ...options, enclosureId: id });
        if (entity === "animals") {
          relations.checkups = await store.list("checkups", { ...options, animalId: id });
          relations.offspring = await store.list("animals", { ...options, parentId: id });
        }
        if (entity === "employees") relations.checkups = await store.list("checkups", { ...options, employeeId: id });
        return reply({ record, relations });
      }
      if ((request.method === "POST" && !id) || (request.method === "PUT" && id)) {
        if (!request.headers.get("content-type")?.includes("application/json")) throw new HttpError(415, "Send application/json");
        let body;
        try { body = await request.json(); } catch { throw new HttpError(400, "Invalid JSON body"); }
        const input = schemas[entity].parse(body);
        if (entity === "animals" && id && "parentId" in input && input.parentId === id) throw new HttpError(400, "An animal cannot be its own parent.");
        if (id) return reply(await store.update(entity, id, input));
        return reply(await store.create(entity, input), 201);
      }
      if (request.method === "DELETE" && id) {
        await store.delete(entity, id);
        return reply({ deleted: id });
      }
      throw new HttpError(405, "Method not allowed");
    } catch (error) {
      if (error instanceof ZodError) return reply({ error: "Please check the form fields.", issues: error.issues.map(i => ({ field: i.path.join("."), message: i.message })) }, 400);
      if (error instanceof HttpError) return reply({ error: error.message }, error.status);
      console.error("API request failed:", error);
      return reply({ error: "Database request failed. Check the backend logs and try again." }, 503);
    }
  };
}
