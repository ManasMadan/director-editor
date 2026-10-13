/**
 * Starts Claude Code's Postgres MCP server (.mcp.json) against the local `app` database,
 * as the local read-only role (infra/postgres/init/02-readonly-role.sql), on the port
 * this checkout's Postgres uses (.env, else .env.example's). When nothing listens there
 * it stops within a second and says what to do, instead of the server hanging past
 * Claude Code's 30-second start limit.
 */
import { ENV_EXAMPLE_PATH, ENV_PATH, listening, readEnv, runMain } from "./lib";

// renovate: datasource=pypi depName=postgres-mcp
const SERVER = "postgres-mcp@0.3.0";
// The MCP SDK the server runs on, pinned too: uvx would otherwise take the newest.
// renovate: datasource=pypi depName=mcp
const SDK = "mcp==1.30.0";

/**
 * The local Postgres port: .env's, else .env.example's, the one place its default is
 * written (docker-compose.yml reads the same variable).
 */
export function postgresPort(envPath = ENV_PATH, examplePath = ENV_EXAMPLE_PATH): number {
  const port = readEnv(envPath).get("POSTGRES_PORT") ?? readEnv(examplePath).get("POSTGRES_PORT");
  if (port === undefined) {
    throw new Error(`POSTGRES_PORT is in neither ${envPath} nor ${examplePath}`);
  }
  return Number(port);
}

interface Server {
  exited: Promise<number>;
}
type Start = (
  command: string[],
  options: { env: Record<string, string | undefined>; stdio: ["inherit", "inherit", "inherit"] },
) => Server;

/** Runs the server until it exits; its exit code, or 1 when Postgres isn't up. */
export async function startServer(
  port = postgresPort(),
  start: Start = Bun.spawn,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (!(await listening(port))) {
    console.error(
      `Postgres isn't running on localhost:${port}. Start it with \`bun run db:up\`, then reconnect this server with /mcp.`,
    );
    return 1;
  }
  const server = start(["uvx", "--with", SDK, SERVER, "--access-mode=restricted"], {
    env: { ...env, DATABASE_URI: `postgresql://app_readonly:app_readonly@localhost:${port}/app` },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return server.exited;
}

await runMain(import.meta, startServer);
