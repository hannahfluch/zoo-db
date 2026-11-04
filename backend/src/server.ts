import { createHandler } from "./api";
import { connect } from "./connections";

const { stores, close } = await connect();
const server = Bun.serve({ hostname: "0.0.0.0", port: Number(process.env.PORT || 3000), maxRequestBodySize: 64 * 1024, fetch: createHandler(stores) });
console.log(`Zoo API listening on ${server.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => { await server.stop(); await close(); process.exit(0); });
