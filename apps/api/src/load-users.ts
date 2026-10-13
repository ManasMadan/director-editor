/**
 * Signed-in users for the load tests (load/): `bun run --cwd apps/api load:users`.
 *
 * Sign-in is rate limited per IP by design, so a load test can't sign in hundreds of
 * virtual users itself. This signs LOAD_USERS of them in through the app's own auth
 * configuration instead, once, and writes their session cookies to load/.sessions.json
 * for k6 (see src/seed/load-users.ts). Refuses to run in production.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATABASE, type Database } from "@repo/nest-common";
import * as z from "zod";
import { AUTH, type Auth } from "./auth/auth.module";
import { env } from "./env";
import { signInLoadUsers } from "./seed/load-users";
import { createApiServer } from "./server";

if (env.NODE_ENV === "production") {
  console.error("Load-test users are for development and test environments only.");
  process.exit(1);
}

const count = z.coerce.number().int().min(1).max(1_000).default(50).parse(process.env.LOAD_USERS);
const output = join(import.meta.dirname, "..", "..", "..", "load", ".sessions.json");

const app = await createApiServer();
await app.init();
try {
  const sessions = await signInLoadUsers(
    { auth: app.get<Auth>(AUTH), database: app.get<Database>(DATABASE) },
    count,
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(sessions, null, 2)}\n`);
  console.log(`${count} signed-in users written to ${output}`);
} finally {
  await app.close();
}
