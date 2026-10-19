import { createApp } from "./app.js";
import { createPool, PostgresRepository } from "./postgres.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1–65535.");
const publicOrigin = process.env.PUBLIC_ORIGIN;
if (publicOrigin) {
  const url = new URL(publicOrigin);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== publicOrigin) {
    throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a trailing slash.");
  }
}
const pool = createPool();
if (process.env.WEBSITE_HOSTNAME && !publicOrigin) {
  throw new Error("PUBLIC_ORIGIN is required for the Azure deployment.");
}
const server = createApp({
  repository: new PostgresRepository(pool),
  ...(publicOrigin ? { publicOrigin } : {}),
  trustProxy: process.env.WEBSITE_HOSTNAME ? 1 : false,
}).listen(port, "0.0.0.0", () => {
  console.info(`Find your next escape listening on port ${port}.`);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => { void pool.end().then(() => process.exit(0), () => process.exit(1)); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
