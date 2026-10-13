import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresPort, startServer } from "./mcp-postgres";
import { captureOutput } from "./stand-ins";

const servers: Server[] = [];
afterEach(() => {
  mock.restore();
  for (const server of servers.splice(0)) {
    server.close();
  }
});

async function openPort() {
  const server = createServer().listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return (server.address() as { port: number }).port;
}

async function closedPort() {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("the Postgres MCP server's start", () => {
  it("uses .env's port, else .env.example's, and refuses to guess one", () => {
    expect(Number.isInteger(postgresPort())).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "mcp-postgres-"));
    const env = join(dir, ".env");
    const example = join(dir, ".env.example");
    writeFileSync(example, "POSTGRES_PORT=55432\n");
    expect(postgresPort(env, example)).toBe(55432);
    writeFileSync(env, "POSTGRES_PORT=55433\n");
    expect(postgresPort(env, example)).toBe(55433);
    writeFileSync(env, "");
    writeFileSync(example, "");
    expect(() => postgresPort(env, example)).toThrow("POSTGRES_PORT is in neither");
  });

  it("starts the server as the read-only role on the local port, and exits with it", async () => {
    const port = await openPort();
    const started: { command: string[]; uri?: string }[] = [];
    const code = await startServer(
      port,
      (command, options) => {
        started.push({ command, uri: options.env.DATABASE_URI });
        return { exited: Promise.resolve(3) };
      },
      { PATH: "/bin" },
    );
    expect(code).toBe(3);
    expect(started).toEqual([
      {
        command: ["uvx", "--with", "mcp==1.30.0", "postgres-mcp@0.3.0", "--access-mode=restricted"],
        uri: `postgresql://app_readonly:app_readonly@localhost:${port}/app`,
      },
    ]);
  });

  it("says how to start Postgres instead of starting a server that would hang", async () => {
    const printed = captureOutput();
    const port = await closedPort();
    const start = () => {
      throw new Error("must not start");
    };
    expect(await startServer(port, start)).toBe(1);
    expect(printed()).toContain(`isn't running on localhost:${port}`);
  });
});
