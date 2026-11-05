import { randomUUID } from "node:crypto";
import { MongoClient, type ClientSession, type Document, type Filter } from "mongodb";
import { entities, HttpError, searchFields, type Entity, type Input, type ListOptions, type RecordData, type Store } from "./model";

export class MongoStore implements Store {
  db;
  constructor(public client: MongoClient, database = "zoo") { this.db = client.db(database); }
  collection(entity: Entity) { return this.db.collection<Document & { _id: string }>(entity); }
  async init() {
    // The Compose instance is a single-node replica set to support atomic embedded writes.
    try { await this.client.db("admin").command({ replSetGetStatus: 1 }); }
    catch (error: any) {
      if (error.code !== 94) throw error;
      try { await this.client.db("admin").command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: "mongo:27017" }] } }); }
      catch (initError: any) { if (initError.code !== 23) throw initError; }
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await this.client.db("admin").command({ hello: 1 })).isWritablePrimary) break;
      if (attempt === 59) throw new Error("MongoDB primary election timed out");
      await Bun.sleep(1000);
    }
    for (const entity of entities) {
      try { await this.db.createCollection(entity); } catch (error: any) { if (error.code !== 48) throw error; }
    }
    await this.collection("enclosures").createIndex({ name: 1 }, { unique: true });
    await this.collection("employees").createIndex({ email: 1 }, { unique: true });
  }
  async ping() { await this.db.command({ ping: 1 }); }
  normalize(doc: any): RecordData { const { _id, _revision, ...data } = doc; return { id: String(_id), ...data }; }
  async stats() {
    return Object.fromEntries(await Promise.all(entities.map(async e => [e, await this.collection(e).countDocuments()]))) as Record<Entity, number>;
  }
  async list(entity: Entity, options: ListOptions) {
    const filter: Filter<Document & { _id: string }> = {};
    if (options.q) {
      const escaped = options.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = searchFields[entity].map(field => ({ [field]: { $regex: escaped, $options: "i" } }));
    }
    const filters = entity === "checkups" ? { animalId: "animal.id", employeeId: "employee.id" } : entity === "animals" ? { enclosureId: "enclosure.id", parentId: "parent.id" } : {};
    for (const [key, field] of Object.entries(filters)) if (options[key as keyof ListOptions]) filter[field] = options[key as keyof ListOptions];
    const total = await this.collection(entity).countDocuments(filter);
    const docs = await this.collection(entity).find(filter).sort(entity === "checkups" ? { checkedAt: -1, _id: -1 } : { _id: 1 }).skip((options.page - 1) * options.limit).limit(options.limit).toArray();
    return { items: docs.map(d => this.normalize(d)), total, page: options.page, limit: options.limit };
  }
  async get(entity: Entity, id: string) {
    const doc = await this.collection(entity).findOne({ _id: id });
    return doc ? this.normalize(doc) : null;
  }
  async create(entity: Entity, input: Input) {
    const session = this.client.startSession();
    const id = randomUUID();
    try {
      await session.withTransaction(async () => {
        const options = { session };
        let doc: Document & { _id: string } = { _id: id, ...input };
        if (entity === "enclosures") doc.animals = [];
        if (entity === "employees") doc.checkups = [];
        if (entity === "animals") {
          const enclosure = await this.required("enclosures", input.enclosureId, session);
          const parent = input.parentId ? await this.required("animals", input.parentId, session) : null;
          doc = { _id: id, name: input.name, birthDate: input.birthDate, enclosure: { id: enclosure._id, name: enclosure.name }, parent: parent ? { id: parent._id, name: parent.name } : null, children: [], checkups: [] };
          await this.collection("enclosures").updateOne({ _id: enclosure._id }, { $push: { animals: { id, name: input.name, birthDate: input.birthDate } } } as any, options);
          if (parent) await this.collection("animals").updateOne({ _id: parent._id }, { $push: { children: { id, name: input.name, birthDate: input.birthDate } } } as any, options);
        }
        if (entity === "checkups") {
          const animal = await this.required("animals", input.animalId, session);
          const employee = await this.required("employees", input.employeeId, session);
          doc = { _id: id, checkedAt: new Date(input.checkedAt), notes: input.notes, animal: { id: animal._id, name: animal.name }, employee: { id: employee._id, firstName: employee.firstName, lastName: employee.lastName } };
          const common = { id, checkedAt: doc.checkedAt, notes: doc.notes };
          // Server-side push/sort/slice handles concurrent writes and backdated examinations.
          await this.collection("animals").updateOne({ _id: animal._id }, { $push: { checkups: { $each: [{ ...common, employee: doc.employee }], $sort: { checkedAt: -1, id: -1 }, $slice: 100 } } } as any, options);
          await this.collection("employees").updateOne({ _id: employee._id }, { $push: { checkups: { $each: [{ ...common, animal: doc.animal }], $sort: { checkedAt: -1, id: -1 }, $slice: 100 } } } as any, options);
        }
        await this.collection(entity).insertOne(doc, options);
      });
      return (await this.get(entity, id))!;
    } catch (error: any) {
      if (error.code === 11000) throw new HttpError(409, "An enclosure with that name or an employee with that email already exists.");
      throw error;
    } finally { await session.endSession(); }
  }
  private async required(entity: Entity, id: string, session: ClientSession) {
    // Touch the referenced document so concurrent rename/delete transactions
    // conflict and retry rather than committing stale or dangling summaries.
    const doc = await this.collection(entity).findOneAndUpdate({ _id: id }, { $inc: { _revision: 1 } }, { session, returnDocument: "after" });
    if (!doc) throw new HttpError(400, `Related ${entity} record does not exist.`);
    return doc;
  }
  private async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try { return (await session.withTransaction(() => operation(session)))!; }
    catch (error: any) {
      if (error.code === 11000) throw new HttpError(409, "An enclosure with that name or an employee with that email already exists.");
      throw error;
    } finally { await session.endSession(); }
  }
  private async refreshHistory(entity: "animals" | "employees", id: string, session: ClientSession) {
    const field = entity === "animals" ? "animal" : "employee";
    const other = entity === "animals" ? "employee" : "animal";
    const history = await this.collection("checkups").find({ [`${field}.id`]: id }, { session }).sort({ checkedAt: -1, _id: -1 }).limit(100).toArray();
    const checkups = history.map(c => ({ id: c._id, checkedAt: c.checkedAt, notes: c.notes, [other]: c[other] }));
    await this.collection(entity).updateOne({ _id: id }, { $set: { checkups } }, { session });
  }
  async update(entity: Entity, id: string, input: Input) {
    await this.transaction(async session => {
      const options = { session };
      const previous = await this.collection(entity).findOne({ _id: id }, options);
      if (!previous) throw new HttpError(404, "Record not found");
      if (entity === "enclosures") {
        await this.collection(entity).updateOne({ _id: id }, { $set: input }, options);
        await this.collection("animals").updateMany({ "enclosure.id": id }, { $set: { "enclosure.name": input.name } }, options);
      }
      if (entity === "employees") {
        await this.collection(entity).updateOne({ _id: id }, { $set: input }, options);
        const employee = { id, firstName: input.firstName, lastName: input.lastName };
        await this.collection("checkups").updateMany({ "employee.id": id }, { $set: { employee } }, options);
        await this.collection("animals").updateMany({ "checkups.employee.id": id }, { $set: { "checkups.$[c].employee": employee } }, { ...options, arrayFilters: [{ "c.employee.id": id }] });
      }
      if (entity === "animals") {
        if (input.parentId === id) throw new HttpError(400, "An animal cannot be its own parent.");
        const enclosure = await this.required("enclosures", input.enclosureId, session);
        const parent = input.parentId ? await this.required("animals", input.parentId, session) : null;
        await this.collection(entity).updateOne({ _id: id }, { $set: { name: input.name, birthDate: input.birthDate, enclosure: { id: enclosure._id, name: enclosure.name }, parent: parent ? { id: parent._id, name: parent.name } : null } }, options);
        await this.collection("enclosures").updateOne({ _id: previous.enclosure.id }, { $pull: { animals: { id } } } as any, options);
        await this.collection("enclosures").updateOne({ _id: enclosure._id }, { $push: { animals: { id, name: input.name, birthDate: input.birthDate } } } as any, options);
        await this.collection("animals").updateMany({ "parent.id": id }, { $set: { "parent.name": input.name } }, options);
        if (previous.parent) await this.collection("animals").updateOne({ _id: previous.parent.id }, { $pull: { children: { id } } } as any, options);
        if (parent) await this.collection("animals").updateOne({ _id: parent._id }, { $push: { children: { id, name: input.name, birthDate: input.birthDate } } } as any, options);
        const animal = { id, name: input.name };
        await this.collection("checkups").updateMany({ "animal.id": id }, { $set: { animal } }, options);
        await this.collection("employees").updateMany({ "checkups.animal.id": id }, { $set: { "checkups.$[c].animal": animal } }, { ...options, arrayFilters: [{ "c.animal.id": id }] });
      }
      if (entity === "checkups") {
        const animal = await this.required("animals", input.animalId, session);
        const employee = await this.required("employees", input.employeeId, session);
        await this.collection(entity).updateOne({ _id: id }, { $set: { checkedAt: new Date(input.checkedAt), notes: input.notes, animal: { id: animal._id, name: animal.name }, employee: { id: employee._id, firstName: employee.firstName, lastName: employee.lastName } } }, options);
        for (const ownerId of new Set([previous.animal.id, animal._id])) await this.refreshHistory("animals", ownerId, session);
        for (const ownerId of new Set([previous.employee.id, employee._id])) await this.refreshHistory("employees", ownerId, session);
      }
    });
    return (await this.get(entity, id))!;
  }
  async delete(entity: Entity, id: string) {
    await this.transaction(async session => {
      const options = { session };
      const record = await this.collection(entity).findOne({ _id: id }, options);
      if (!record) throw new HttpError(404, "Record not found");
      let referenced = false;
      if (entity === "enclosures") referenced = !!await this.collection("animals").findOne({ "enclosure.id": id }, options);
      if (entity === "employees") referenced = !!await this.collection("checkups").findOne({ "employee.id": id }, options);
      if (referenced) throw new HttpError(409, "This record is still referenced. Remove or reassign its related records first.");
      await this.collection(entity).deleteOne({ _id: id }, options);
      if (entity === "animals") {
        // Collect every affected employee from the full history, including
        // checkups outside the animal's bounded embedded history.
        const employeeIds = await this.collection("checkups").distinct("employee.id", { "animal.id": id }, options);
        await this.collection("checkups").deleteMany({ "animal.id": id }, options);
        await this.collection("animals").updateMany({ "parent.id": id }, { $set: { parent: null } }, options);
        if (record.parent) await this.collection("animals").updateOne({ _id: record.parent.id }, { $pull: { children: { id } } } as any, options);
        await this.collection("enclosures").updateOne({ _id: record.enclosure.id }, { $pull: { animals: { id } } } as any, options);
        for (const employeeId of employeeIds) await this.refreshHistory("employees", employeeId, session);
      }
      if (entity === "checkups") {
        await this.refreshHistory("animals", record.animal.id, session);
        await this.refreshHistory("employees", record.employee.id, session);
      }
    });
  }
}
