import { createHandler } from "./api";
import { connect } from "./connections";
import { BenchmarkService } from "./benchmark";

const { stores, close } = await connect();
const port = Number(process.env.PORT || 3000);
const benchmark = new BenchmarkService(stores, `http://127.0.0.1:${port}`);
const server = Bun.serve({ hostname: "0.0.0.0", port, idleTimeout: 255, maxRequestBodySize: 64 * 1024, fetch: createHandler(stores, benchmark) });
console.log(`Zoo API listening on ${server.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => { await server.stop(); await close(); process.exit(0); });
