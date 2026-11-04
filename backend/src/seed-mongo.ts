import { connect } from "./connections";
import { entities, type Entity, type RecordData } from "./model";

// Explicit, non-destructive import for an initially empty MongoDB database.
const { stores, close } = await connect();
try {
  const source = {} as Record<Entity, RecordData[]>;
  for (const entity of entities) {
    source[entity] = [];
    for (let page = 1; ; page++) {
      const result = await stores.postgres.list(entity, { q: "", page, limit: 100 });
      source[entity].push(...result.items);
      if (page * result.limit >= result.total) break;
    }
  }
  const docs = Object.fromEntries(entities.map(entity => [entity, source[entity].map(({ id, ...record }) => ({ _id: id, ...record }))])) as Record<Entity, any[]>;
  const animals = new Map(docs.animals.map(a => [a._id, a]));
  const employees = new Map(docs.employees.map(e => [e._id, e]));
  const enclosures = new Map(docs.enclosures.map(e => [e._id, e]));
  for (const enclosure of docs.enclosures) enclosure.animals = [];
  for (const employee of docs.employees) employee.checkups = [];
  for (const animal of docs.animals) {
    animal.checkups = [];
    enclosures.get(animal.enclosure.id).animals.push({ id: animal._id, name: animal.name, birthDate: animal.birthDate });
  }
  docs.checkups.sort((a, b) => new Date(b.checkedAt).getTime() - new Date(a.checkedAt).getTime() || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
  for (const checkup of docs.checkups) {
    checkup.checkedAt = new Date(checkup.checkedAt);
    const common = { id: checkup._id, checkedAt: checkup.checkedAt, notes: checkup.notes };
    const animal = animals.get(checkup.animal.id);
    const employee = employees.get(checkup.employee.id);
    if (animal.checkups.length < 100) animal.checkups.push({ ...common, employee: checkup.employee });
    if (employee.checkups.length < 100) employee.checkups.push({ ...common, animal: checkup.animal });
  }
  const session = stores.mongo.client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const entity of entities) {
        if (await stores.mongo.collection(entity).countDocuments({}, { session })) throw new Error("MongoDB is not empty. Import refused; no records were changed.");
      }
      for (const entity of entities) {
        for (let offset = 0; offset < docs[entity].length; offset += 1000) await stores.mongo.collection(entity).insertMany(docs[entity].slice(offset, offset + 1000), { session });
      }
    });
  } finally { await session.endSession(); }
  console.log("Imported PostgreSQL records into MongoDB:", await stores.mongo.stats());
} finally { await close(); }
