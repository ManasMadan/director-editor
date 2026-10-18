/**
 * Gives every workspace Director's seeded templates it's missing: those made before new
 * workspaces got them at creation, or whose team-workspace copy failed. `bun run --filter
 * @repo/api director:seed-workspaces` locally; deployed, the api image with the command
 * `node dist/director-seed-workspaces.mjs`. Safe on a live database and to run again: it
 * only adds seed rows a workspace doesn't have, and never changes a plan
 * (src/modules/director/seeds.repository.ts).
 */
import { createDatabase } from "@repo/db";
import { env } from "./env";
import { seedWorkspaces } from "./modules/director/seeds.repository";

const database = createDatabase({
  url: env.API_DATABASE_URL,
  poolMax: 2,
  service: "director-seed-workspaces",
});
try {
  const { workspaces, seeded, templates } = await seedWorkspaces(database);
  console.log(
    `Checked ${workspaces} workspaces: copied ${templates} seeded templates into ${seeded} of them.`,
  );
} finally {
  await database.disconnect();
}
