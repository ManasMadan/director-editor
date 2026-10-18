/**
 * Makes Director's shared demo account (src/auth/demo.ts), or puts it right:
 * `bun run --filter @repo/api director:demo-account` locally (with `--force`: outside
 * production it refuses without it), deployed the api image with the command
 * `node dist/director-demo-account.mjs`. It needs DEMO_PASSWORD, the password it gives the
 * account and the sign-in page shows.
 *
 * Safe to run again: it keeps the account and what was done with it (its own Short, takes
 * and cuts), and only sets the password, the flag and any missing seeded template.
 * `--reset` starts over instead: it deletes the account and its workspaces, everything
 * made in them with them, and makes it again with just the seeds.
 */
import { DATABASE, type Database } from "@repo/nest-common";
import { AUTH, type Auth } from "./auth/auth.module";
import { DEMO_EMAIL } from "./auth/demo";
import { type DemoAccountOutcome, demoCommand, ensureDemoAccount } from "./auth/demo-account";
import { env } from "./env";
import { createApiServer } from "./server";

const command = demoCommand(process.argv.slice(2), env.NODE_ENV, env.DEMO_PASSWORD);
if ("refused" in command) {
  console.error(command.refused);
  process.exit(1);
}

const app = await createApiServer();
await app.init();
try {
  const result = await ensureDemoAccount(
    { auth: app.get<Auth>(AUTH), database: app.get<Database>(DATABASE) },
    command,
  );
  console.log(said(result));
} finally {
  await app.close();
}

function said(result: DemoAccountOutcome) {
  switch (result.outcome) {
    case "created":
      return `Created the demo account ${DEMO_EMAIL}.`;
    case "reset":
      return `Reset the demo account ${DEMO_EMAIL}: deleted it with its workspaces (its own Shorts, takes and cuts), then made it again.`;
    case "updated":
      return `Updated the demo account ${DEMO_EMAIL}: copied ${result.templates} missing seeded templates, and kept its own Shorts and takes.`;
  }
}
