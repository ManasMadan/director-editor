// A stand-in service: serves one HTTP request that logs, queries Postgres and calls Redis.
import { createServer } from "node:http";
import { Redis } from "ioredis";
import pg from "pg";
import pino from "pino";

const log = pino();
const database = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
await database.connect();
const redis = new Redis(process.env.TELEMETRY_TEST_REDIS_URL, { maxRetriesPerRequest: null });

const server = createServer(async (_request, response) => {
  log.info("handling a request");
  await database.query("SELECT 1");
  await redis.ping();
  response.end("ok");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
// A query like an OAuth callback's, whose values must not reach a trace.
await fetch(`http://127.0.0.1:${server.address().port}/work?code=secret-code&state=s1`).then(
  (response) => response.text(),
);

server.close();
await database.end();
await redis.quit();
