/**
 * Status line: branch, uncommitted changes and which core local services accept
 * connections. It runs after every assistant message, so it stays at about 100ms: one
 * git call and a TCP connect per service (localhost refuses instantly when nothing
 * listens). It never calls Docker, which can take seconds to answer.
 */
import { ENV_EXAMPLE_PATH, ENV_PATH, listening, readEnv, runMain } from "../../scripts/lib";

/** The core services' host ports: .env's, else .env.example's (docker-compose.yml's). */
export function servicePorts(env = readEnv(ENV_PATH), example = readEnv(ENV_EXAMPLE_PATH)) {
  const port = (key: string) => Number(env.get(key) ?? example.get(key));
  return [
    { name: "pg", port: port("POSTGRES_PORT") },
    { name: "valkey", port: port("VALKEY_PORT") },
    { name: "mail", port: port("MAILPIT_SMTP_PORT") },
  ];
}

/** The status line for the session `stdin` describes (JSON; anything else is ignored). */
export async function statusline(
  stdin: { json(): Promise<unknown> } = Bun.stdin,
  services = servicePorts(),
): Promise<string> {
  const input = (await stdin.json().catch(() => ({}))) as {
    workspace?: { project_dir?: string };
  };
  const cwd = input.workspace?.project_dir ?? process.cwd();

  const git = Bun.spawnSync(["git", "status", "--porcelain=v1", "--branch"], { cwd });
  const [head = "", ...changes] = git.stdout.toString().trim().split("\n");
  const branch = head.replace(/^## /, "").split("...")[0] || "no git";
  const dirty = changes.filter(Boolean).length;

  const up = await Promise.all(services.map((service) => listening(service.port, 150)));
  const status = services
    .map((service, index) => `${service.name} ${up[index] ? "up" : "down"}`)
    .join(" ");
  return `${branch}${dirty ? ` +${dirty}` : ""} | ${status}`;
}

/** Prints the status line (Claude Code's statusLine command). */
export async function printStatusline(
  write: (text: string) => unknown = process.stdout.write.bind(process.stdout),
  stdin?: Parameters<typeof statusline>[0],
) {
  write(await statusline(stdin));
}

await runMain(import.meta, printStatusline);
