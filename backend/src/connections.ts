import pg from "pg";
import { MongoClient } from "mongodb";
import { PostgresStore } from "./postgres";
import { MongoStore } from "./mongo";

export async function connect() {
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL, host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432), database: process.env.PGDATABASE || "zoo", user: process.env.PGUSER || "zoo", password: process.env.PGPASSWORD || "zoo_local_password", max: 10, connectionTimeoutMillis: 5000 });
  pool.on("error", error => console.error("PostgreSQL pool error:", error.message));
  const client = new MongoClient(process.env.MONGO_URL || "mongodb://localhost:27017/zoo?directConnection=true", { serverSelectionTimeoutMS: 5000, ...(!process.env.MONGO_URL || process.env.MONGO_PASSWORD ? { auth: { username: process.env.MONGO_USERNAME || "zoo", password: process.env.MONGO_PASSWORD || "zoo_mongo_local_password" }, authSource: "admin" } : {}) });
  try {
    await client.connect();
    const stores = { postgres: new PostgresStore(pool), mongo: new MongoStore(client, process.env.MONGO_DATABASE || "zoo") };
    await stores.postgres.ping();
    await stores.mongo.init();
    return { stores, close: async () => { await Promise.all([pool.end(), client.close()]); } };
  } catch (error) { await Promise.all([pool.end(), client.close()]); throw error; }
}
