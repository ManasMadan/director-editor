import { afterEach, describe, expect, it, mock } from "bun:test";
import { IMAGES, request, smoke } from "./image-smoke";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const fast = { timeoutMs: 50, pollMs: 1 };

describe("image smoke", () => {
  it("starts the service on the host's network and needs every path to answer 200", async () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun();
    const asked: string[] = [];
    let first = true;
    const get = async (url: string) => {
      asked.push(url);
      // Not listening yet on the first try: it waits and asks again.
      if (first) {
        first = false;
        throw new Error("ECONNREFUSED");
      }
      return { status: 200 };
    };
    expect(await smoke("api", { run, get, ...fast })).toBe(0);
    expect(calls[0]).toStartWith("docker run --name smoke-api --network host -e PORT=3001");
    expect(calls[0]).toEndWith("--detach boilerplate/api:dev");
    expect(asked).toEqual([
      "http://127.0.0.1:3001/health/dependencies",
      "http://127.0.0.1:3001/health/dependencies",
      "http://127.0.0.1:3001/api/v1/system",
    ]);
    expect(calls.at(-1)).toBe("docker rm --force smoke-api");
    expect(calls).not.toContain("docker logs smoke-api");
    expect(printed()).toContain("api: /api/v1/system → 200");
  });

  it("fails with the container's logs when a path never answers 200", async () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun();
    const get = async (url: string) => ({ status: url.endsWith("/privacy") ? 500 : 200 });
    expect(await smoke("web", { run, get, ...fast })).toBe(1);
    expect(calls).toContain("docker logs smoke-web");
    expect(calls.at(-1)).toBe("docker rm --force smoke-web");
    expect(printed()).toContain("web: /privacy → 500");
  });

  it("fails when the container doesn't start", async () => {
    const printed = captureOutput();
    const { run } = fakeRun(() => ({ status: 125, stderr: "no such image\n" }));
    expect(await smoke("worker", { run, get: async () => ({ status: 200 }), ...fast })).toBe(1);
    expect(printed()).toContain("worker: didn't start: no such image");
  });

  it("runs the migrate image to the end and needs it to exit 0", async () => {
    const printed = captureOutput();
    const passing = fakeRun();
    expect(await smoke("migrate", { run: passing.run })).toBe(0);
    expect(passing.calls).toEqual([
      "docker run --name smoke-migrate --network host -e MIGRATOR_DATABASE_URL=postgresql://migrator:migrator@127.0.0.1:5432/app --rm boilerplate/migrate:dev",
    ]);
    const failing = fakeRun(() => ({ status: 1 }));
    expect(await smoke("migrate", { run: failing.run })).toBe(1);
    expect(printed()).toContain("migrate: exited 1");
  });

  it("asks with a real request, which gives up on its own", async () => {
    using server = Bun.serve({ port: 0, fetch: () => new Response("ok", { status: 204 }) });
    expect((await request(`http://127.0.0.1:${server.port}/`)).status).toBe(204);
  });

  it("names the images it knows when given another", async () => {
    const printed = captureOutput();
    expect(await smoke("nope")).toBe(2);
    expect(await smoke(undefined)).toBe(2);
    expect(printed()).toContain("<api|worker|notifications|webhooks|web|ai|migrate>");
  });

  it("covers every image the bake file builds", async () => {
    const bake = await Bun.file(`${import.meta.dir}/../docker-bake.hcl`).text();
    const group = /group "default" \{\s*targets = \[([^\]]*)\]/.exec(bake)?.[1] ?? "";
    const targets = [...group.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(Object.keys(IMAGES).sort()).toEqual(targets.sort());
  });

  // What the services validate at boot, run here with the image's NODE_ENV: a variable a
  // service starts requiring fails this, not the images job after a ten-minute build.
  it.each([
    ["api", "apps/api/src/env.ts"],
    ["worker", "apps/worker/src/env.ts"],
    ["notifications", "apps/notifications/src/env.ts"],
    ["webhooks", "apps/webhooks/src/env.ts"],
    ["web", "apps/web/src/env.ts"],
  ])(
    "gives %s everything its configuration requires in production",
    (image, file) => {
      const spec = IMAGES[image];
      // In the repository, so bunfig.toml keeps the checkout's .env out of it.
      const result = Bun.spawnSync(["bun", "-e", `await import("./${file}")`], {
        cwd: `${import.meta.dir}/..`,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: "production",
          ...spec?.env(),
        },
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      // A cold Bun loading a service's whole config takes several seconds on a busy machine.
    },
    30_000,
  );

  it("gives the AI service every setting it has no default for", async () => {
    const settings = await Bun.file(`${import.meta.dir}/../apps/ai/app/settings.py`).text();
    const required = [...settings.matchAll(/Field\((?:min_length=\d+, )?alias="(\w+)"\)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(required.length).toBeGreaterThan(0);
    expect(Object.keys(IMAGES.ai?.env() ?? {}).sort()).toEqual(required.sort());
  });
});
