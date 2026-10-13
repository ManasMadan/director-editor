/**
 * Demo data for local development: `bun run db:seed` (see src/seed/demo.ts for what it
 * creates). Running it again changes nothing. Refuses to run in production.
 */
import { DATABASE, type Database } from "@repo/nest-common";
import { AUTH, type Auth } from "./auth/auth.module";
import { env } from "./env";
import { TodoService } from "./modules/todo";
import { DEMO_PASSWORD, DEMO_PEOPLE, seedDemo } from "./seed/demo";
import { createApiServer } from "./server";

if (env.NODE_ENV === "production") {
  console.error("The demo seed is for development only.");
  process.exit(1);
}

const app = await createApiServer();
await app.init();
try {
  const seeded = await seedDemo({
    auth: app.get<Auth>(AUTH),
    database: app.get<Database>(DATABASE),
    todos: app.get(TodoService),
  });
  console.log(seeded ? "Seeded." : "Already seeded. `bun run db:reset` starts over.");
  console.log(`Sign in at ${env.WEB_URL}/sign-in with any of:`);
  for (const person of DEMO_PEOPLE) {
    console.log(`  ${person.email} / ${DEMO_PASSWORD}`);
  }
} finally {
  await app.close();
}
