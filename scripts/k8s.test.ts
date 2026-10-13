import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addon, type Cluster, k8s } from "./k8s";
import { type Ran, ROOT } from "./lib";
import { captureOutput, fakeRun } from "./stand-ins";

const servers: ReturnType<typeof Bun.serve>[] = [];
/** What the runs registered for the process's exit: their logs go after each test. */
const atExit: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const handler of atExit.splice(0)) {
    handler();
  }
});

const KUBECTL = "kubectl --context kind-boilerplate";

/** The gateway on port 80, as a server of the test's: `answer` gets each request's host and path. */
function gateway(answer: (host: string, path: string) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => answer(request.headers.get("host") ?? "", new URL(request.url).pathname),
  });
  servers.push(server);
  return { port: server.port ?? 0, timeoutMs: 2000 };
}

/** Every route answering as a healthy stack's do. */
const healthy = (host: string, path: string) => {
  if (host === "files.localhost") {
    return new Response(null, { status: path === "/health" ? 200 : 404 });
  }
  if (path === "/ai/mcp") {
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Bearer resource_metadata="http://localhost/.well-known/x"' },
    });
  }
  if (path === "/webhooks/stripe") {
    return new Response(null, { status: 405 });
  }
  return new Response("ok");
};

/**
 * A machine with every tool, 8 GB for Docker and no cluster yet, whose commands are
 * recorded (the side-by-side steps' too). openssl writes stand-in files where it would
 * write the certificates. `answer` overrides a command's result.
 */
function machine(
  answer: (line: string) => Partial<Ran> | undefined = () => undefined,
  overrides: Partial<Cluster> = {},
) {
  const jobStatuses = ["", "1,"];
  const commands = fakeRun((line) => {
    const given = answer(line);
    if (given) {
      return given;
    }
    if (line === "docker info --format {{.MemTotal}}") {
      return { stdout: `${8 * 1024 ** 3}\n` };
    }
    if (line === "docker buildx inspect boilerplate") {
      return { status: 1 };
    }
    if (line.startsWith(`${KUBECTL} -n boilerplate get secret`)) {
      return { status: 1 };
    }
    if (/ get job reencrypt-\d+ /.test(line)) {
      return { stdout: jobStatuses.shift() ?? "1," };
    }
    if (/ logs job\/reencrypt-\d+$/.test(line)) {
      return { stdout: "starting\nRe-encrypted 12 rows\n" };
    }
    return undefined;
  });
  const exitHandlers = atExit;
  const sleeps: number[] = [];
  const given: Partial<Cluster> = {
    run: (command, args, options = {}) => {
      if (command === "openssl" && typeof options.cwd === "string") {
        for (const flag of ["-out", "-keyout"]) {
          const file = args[args.indexOf(flag) + 1];
          if (args.includes(flag) && file) {
            writeFileSync(join(options.cwd, file), `stand-in ${file}`);
          }
        }
      }
      return commands.run(command, args, options);
    },
    start: ([command = "", ...args], options) => {
      const ran = commands.run(command, args, { cwd: options.cwd });
      writeSync(options.stdout, `${ran.stdout}${ran.stderr}`);
      return { exited: Promise.resolve(ran.status ?? 1) };
    },
    sleep: async (ms) => sleeps.push(ms),
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
    onExit: (handler) => exitHandlers.push(handler),
    env: {},
    gateway: gateway(healthy),
    ...overrides,
  };
  return { given, calls: commands.calls, options: commands.options, exitHandlers, sleeps };
}

/** What `kubectl apply -f -` was given, as the list of objects. */
const applied = (options: { input?: unknown }[], index: number) =>
  (JSON.parse(String(options[index]?.input)) as { items: Record<string, unknown>[] }).items;

const IMAGES = ["api", "worker", "notifications", "webhooks", "web", "ai", "migrate"];
const bake = (image: string, ...extra: string[]) =>
  `docker buildx bake ${image} --builder boilerplate --load --set *.args.RELEASE=dev${extra.join("")}`;

describe("the local cluster", () => {
  it("says how to call it", async () => {
    const printed = captureOutput();
    expect(await k8s([], machine().given)).toBe(1);
    expect(printed()).toContain("usage: bun scripts/k8s.ts up | smoke | down");
  });

  it("comes up from nothing: cluster, add-ons, Secrets, images, data, stack, then the smoke test", async () => {
    const printed = captureOutput();
    const logsBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("boilerplate-k8s-"));
    const { given, calls, options, exitHandlers, sleeps } = machine();
    expect(await k8s(["up"], given)).toBe(0);
    const helm = (...args: string[]) =>
      [
        "helm",
        "upgrade",
        "--install",
        ...args,
        "--kube-context",
        "kind-boilerplate",
        "--wait",
      ].join(" ");
    const namespace = `${KUBECTL} -n boilerplate`;
    const job = calls.find((line) => line.includes(" create job "))?.split(" ")[7] ?? "";
    expect(job).toMatch(/^reencrypt-\d+$/);
    expect(calls).toEqual([
      "docker --version",
      "kind version",
      "helm version --short",
      "kubectl version --client",
      "openssl version",
      "docker info --format {{.MemTotal}}",
      "kind get clusters",
      "kind create cluster --config deploy/local/kind.yaml",
      helm("eg", ...addon("envoy-gateway"), "--create-namespace"),
      helm("cnpg", ...addon("cloudnative-pg"), "--create-namespace"),
      helm(
        "keda",
        ...addon("keda"),
        "-f",
        join(ROOT, "deploy/platform/values/keda.yaml"),
        "--create-namespace",
      ),
      `${KUBECTL} create namespace gateway-system`,
      `${KUBECTL} create namespace boilerplate`,
      `${namespace} get secret mailpit-tls`,
      "openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=boilerplate-kind-ca -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign -keyout ca.key -out ca.crt",
      "openssl req -newkey rsa:2048 -nodes -subj /CN=mailpit -keyout tls.key -out tls.csr",
      "openssl x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile ext -out tls.crt",
      `${KUBECTL} apply -f -`,
      `${namespace} get secret boilerplate-api`,
      `${KUBECTL} apply -f -`,
      `${KUBECTL} apply -f deploy/local/gateway.yaml`,
      `${KUBECTL} apply -f deploy/local/mailpit.yaml`,
      "docker buildx inspect boilerplate",
      "docker buildx create --name boilerplate --driver docker-container --driver-opt memory=4g --driver-opt default-load=true",
      ...IMAGES.map((image) => bake(image)),
      `kind load docker-image --name boilerplate ${IMAGES.map((image) => `boilerplate/${image}:dev`).join(" ")}`,
      `${helm("boilerplate-data", join(ROOT, "deploy/charts/data"), "-f", join(ROOT, "deploy/environments/local/data.yaml"), "--namespace", "boilerplate")} --timeout 10m`,
      `${KUBECTL} -n boilerplate wait cluster/boilerplate-data-postgres --for=condition=Ready --timeout=10m`,
      `${helm("boilerplate", join(ROOT, "deploy/charts/stack"), "-f", join(ROOT, "deploy/environments/local/stack.yaml"), "--namespace", "boilerplate")} --timeout 15m`,
      `${KUBECTL} -n boilerplate wait scaledobject/boilerplate-worker --for=condition=Ready --timeout=5m`,
      `${namespace} create job ${job} --from=cronjob/boilerplate-reencrypt`,
      `${namespace} get job ${job} -o jsonpath={.status.succeeded},{.status.failed}`,
      `${namespace} get job ${job} -o jsonpath={.status.succeeded},{.status.failed}`,
      `${namespace} logs job/${job}`,
    ]);
    expect(options.every((given) => given.cwd !== undefined)).toBe(true);
    expect(sleeps).toEqual([2000]);

    // Mailpit's certificate and its authority, from openssl's files, which are then deleted.
    const [ca, tls] = applied(options, 17);
    expect(ca).toMatchObject({
      metadata: { name: "local-ca", namespace: "boilerplate" },
      stringData: { "ca.crt": "stand-in ca.crt" },
    });
    expect(tls).toMatchObject({
      metadata: { name: "mailpit-tls" },
      type: "kubernetes.io/tls",
      stringData: { "tls.crt": "stand-in tls.crt", "tls.key": "stand-in tls.key" },
    });
    expect(existsSync(String(options[14]?.cwd))).toBe(false);

    // The services' Secrets share the values they must agree on.
    const secrets = Object.fromEntries(
      applied(options, 19).map((item) => [
        (item.metadata as { name: string }).name,
        item.stringData as Record<string, string>,
      ]),
    );
    expect(Object.keys(secrets)).toEqual([
      "boilerplate-api",
      "boilerplate-notifications",
      "boilerplate-webhooks",
      "boilerplate-ai",
    ]);
    const { api, notifications, webhooks, ai } = {
      api: secrets["boilerplate-api"],
      notifications: secrets["boilerplate-notifications"],
      webhooks: secrets["boilerplate-webhooks"],
      ai: secrets["boilerplate-ai"],
    };
    expect(api?.ENCRYPTION_KEYS).toMatch(/^k1:[\w+/]{43}=$/);
    expect(webhooks?.ENCRYPTION_KEYS).toBe(api?.ENCRYPTION_KEYS as string);
    expect(notifications?.UNSUBSCRIBE_SECRET).toBe(api?.UNSUBSCRIBE_SECRET as string);
    expect(ai?.AI_SERVICE_SECRET).toBe(api?.AI_SERVICE_SECRET as string);
    expect(notifications?.SMTP_URL).toMatch(
      /^smtps:\/\/no-reply%40boilerplate\.localhost:[\w-]{22}@mailpit:1025$/,
    );

    const output = printed();
    expect(output).toContain("Docker has 8.0 GB of memory");
    expect(output).toContain("secrets (4 created)");
    expect(output).toContain("files: files.localhost/health → 200");
    expect(output).toContain("AI MCP server: /ai/mcp → 401");
    expect(output).toContain("re-encryption: Re-encrypted 12 rows");
    expect(output).toContain("http://localhost");

    // The side-by-side steps' logs go when the process exits.
    const logs = () =>
      readdirSync(tmpdir()).filter(
        (name) => name.startsWith("boilerplate-k8s-") && !logsBefore.includes(name),
      );
    expect(logs()).toHaveLength(1);
    for (const handler of exitHandlers.splice(0)) {
      handler();
    }
    expect(logs()).toEqual([]);
  });

  it("in CI builds every image while the cluster comes up, from deploy.yml's cache", async () => {
    const printed = captureOutput();
    const { given, calls } = machine(
      (line) => {
        if (line === "kind get clusters") {
          return { stdout: "kind\nboilerplate\n" };
        }
        if (line.startsWith(`${KUBECTL} -n boilerplate get secret`)) {
          return { status: 0 };
        }
        return undefined;
      },
      { env: { CI: "true", ACTIONS_CACHE_URL: "https://cache.example" } },
    );
    expect(await k8s(["up"], given)).toBe(0);
    expect(calls).toContain(
      "docker buildx create --name boilerplate --driver docker-container --driver-opt memory=8g --driver-opt default-load=true",
    );
    for (const image of IMAGES) {
      expect(calls).toContain(
        bake(image, ` --set ${image}.cache-from=type=gha,scope=${image}-amd64`),
      );
      expect(calls).toContain(`kind load docker-image --name boilerplate boilerplate/${image}:dev`);
    }
    // The builds start before the add-ons are installed.
    expect(
      calls.indexOf(bake("migrate", " --set migrate.cache-from=type=gha,scope=migrate-amd64")),
    ).toBeLessThan(calls.findIndex((line) => line.startsWith("helm upgrade --install eg ")));
    expect(calls.some((line) => line.startsWith("kind create cluster"))).toBe(false);
    expect(calls.some((line) => line.startsWith("openssl req"))).toBe(false);
    expect(printed()).toContain("cluster (exists)");
    expect(printed()).toContain("Mailpit's certificate (exists)");
    expect(printed()).toContain("secrets (exist)");
  });

  it("builds in the builder that's already there, without its cache in CI unless reachable", async () => {
    captureOutput();
    const { given, calls } = machine(
      (line) => (line === "docker buildx inspect boilerplate" ? { status: 0 } : undefined),
      { env: { CI: "true" } },
    );
    expect(await k8s(["up"], given)).toBe(0);
    expect(calls.some((line) => line.startsWith("docker buildx create"))).toBe(false);
    expect(calls).toContain(bake("api"));
  });

  it("needs every tool", async () => {
    const printed = captureOutput();
    const { given, calls } = machine((line) =>
      line === "kind version" ? { status: 127 } : undefined,
    );
    await expect(k8s(["up"], given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("kind isn't installed");
    expect(calls).toHaveLength(2);
  });

  it("needs 8 GB of memory for Docker", async () => {
    const printed = captureOutput();
    const { given, calls } = machine((line) =>
      line === "docker info --format {{.MemTotal}}" ? { stdout: `${4 * 1024 ** 3}` } : undefined,
    );
    await expect(k8s(["up"], given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("Docker has 4.0 GB of memory; the cluster needs 8 GB.");
    expect(calls.at(-1)).toBe("docker info --format {{.MemTotal}}");
  });

  it("shows the end of a side-by-side step's output when it fails", async () => {
    const printed = captureOutput();
    const output = Array.from({ length: 100 }, (_, index) => `L${index + 1}.`).join("\n");
    const { given, calls } = machine((line) =>
      line.startsWith("kind create cluster") ? { status: 1, stdout: output } : undefined,
    );
    await expect(k8s(["up"], given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("L21.\nL22.");
    expect(printed()).toContain("L100.");
    expect(printed()).not.toContain("L20.");
    expect(calls.at(-1)).toStartWith("kind create cluster");
  });

  it("stops when a step fails, with its error", async () => {
    const printed = captureOutput();
    const { given, calls } = machine((line) =>
      line.endsWith("apply -f deploy/local/gateway.yaml")
        ? { status: 1, stderr: "no matches for kind Gateway\n" }
        : undefined,
    );
    await expect(k8s(["up"], given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("no matches for kind Gateway");
    expect(calls.at(-1)).toEndWith("apply -f deploy/local/gateway.yaml");
  });

  it("stops when Mailpit's certificate can't be made, and deletes what it made", async () => {
    const printed = captureOutput();
    const { given, options } = machine((line) =>
      line.startsWith("openssl req -newkey") ? { status: 1, stderr: "bad subject" } : undefined,
    );
    await expect(k8s(["up"], given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("Mailpit's certificate");
    expect(printed()).toContain("bad subject");
    expect(existsSync(String(options.at(-1)?.cwd))).toBe(false);
  });

  it("stops when the cluster refuses the certificate or the Secrets", async () => {
    const printed = captureOutput();
    const refuse = machine((line) =>
      line === `${KUBECTL} apply -f -` ? { status: 1, stderr: "forbidden" } : undefined,
    );
    await expect(k8s(["up"], refuse.given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("forbidden");
    expect(refuse.calls.at(-1)).toBe(`${KUBECTL} apply -f -`);

    let applies = 0;
    const secrets = machine((line) =>
      line === `${KUBECTL} apply -f -` && ++applies === 2
        ? { status: 1, stderr: "quota" }
        : undefined,
    );
    await expect(k8s(["up"], secrets.given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("quota");
    expect(secrets.calls.at(-2)).toBe(`${KUBECTL} -n boilerplate get secret boilerplate-api`);
  });

  it("smoke-tests a running cluster", async () => {
    const printed = captureOutput();
    const { given } = machine((line) =>
      / logs job\//.test(line) ? { stdout: "nothing to do\n" } : undefined,
    );
    expect(await k8s(["smoke"], given)).toBe(0);
    expect(printed()).toContain("web: /healthz → 200");
    expect(printed()).toContain("webhooks: /webhooks/stripe → 405");
    expect(printed()).toContain("re-encryption: done");
  });

  it("fails the smoke test on every route that doesn't answer as it should", async () => {
    const printed = captureOutput();
    // Nothing listens on the gateway's port.
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = closed.port ?? 0;
    await closed.stop(true);
    const { given, calls } = machine(undefined, { gateway: { port, timeoutMs: 2000 } });
    await expect(k8s(["smoke"], given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("files: files.localhost/health → 0");
    expect(printed()).toContain("api: /api/v1/system → 0");
    expect(calls).toEqual([]);

    // A gateway that takes the connection and never answers.
    const sockets: Socket[] = [];
    const silent = createServer((socket) => sockets.push(socket)).listen(0, "127.0.0.1");
    await new Promise((resolve) => silent.once("listening", resolve));
    const address = silent.address();
    const hanging = machine(undefined, {
      gateway: { port: typeof address === "object" && address ? address.port : 0, timeoutMs: 20 },
    });
    try {
      await expect(k8s(["smoke"], hanging.given)).rejects.toThrow("exit 1");
      expect(printed()).toContain("web page: /sign-in → 0");
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      silent.close();
    }

    const wrong = machine(undefined, {
      gateway: gateway(() => new Response(null, { status: 502 })),
    });
    await expect(k8s(["smoke"], wrong.given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("AI MCP server: /ai/mcp → 502");
  });

  it("fails when re-encryption can't start or fails, with its logs", async () => {
    const printed = captureOutput();
    const refused = machine((line) =>
      line.includes(" create job ") ? { status: 1, stderr: "cronjob not found\n" } : undefined,
    );
    await expect(k8s(["smoke"], refused.given)).rejects.toThrow("exit 1");
    expect(printed()).toContain("re-encryption: cronjob not found");

    const failed = machine((line) => {
      if (/ get job /.test(line)) {
        return { stdout: ",1" };
      }
      if (/ logs job\//.test(line)) {
        return { stdout: "ENCRYPTION_KEYS is malformed\n" };
      }
      return undefined;
    });
    await expect(k8s(["smoke"], failed.given)).rejects.toThrow("exit 1");
    expect(printed()).toMatch(/re-encryption: job reencrypt-\d+ failed/);
    expect(printed()).toContain("ENCRYPTION_KEYS is malformed");
  });

  it("deletes the cluster", async () => {
    captureOutput();
    const { given, calls, options } = machine();
    expect(await k8s(["down"], given)).toBe(0);
    expect(calls).toEqual(["kind delete cluster --name boilerplate"]);
    expect(options[0]).toMatchObject({ cwd: ROOT, stdio: "inherit" });
  });
});

describe("the add-ons kind installs", () => {
  it("come from the clusters' definitions: a Helm repository or an OCI registry", () => {
    expect(addon("cloudnative-pg").slice(0, 3)).toEqual([
      "cloudnative-pg",
      "--repo",
      "https://cloudnative-pg.github.io/charts",
    ]);
    expect(addon("envoy-gateway")[0]).toBe("oci://registry-1.docker.io/envoyproxy/gateway-helm");
    expect(addon("envoy-gateway").slice(-2)).toEqual(["--namespace", "envoy-gateway-system"]);
  });

  it("need a repository, chart, version and namespace", () => {
    const root = mkdtempSync(join(tmpdir(), "addons-"));
    mkdirSync(join(root, "deploy/platform/addons"), { recursive: true });
    writeFileSync(join(root, "deploy/platform/addons/half.yaml"), "chart: half\nversion: 1.0.0\n");
    expect(() => addon("half", root)).toThrow(
      "deploy/platform/addons/half.yaml needs repoURL, chart, version and namespace",
    );
  });
});

describe("kind's Mailpit", () => {
  it("has a writable temp directory for its database, under its read-only root", async () => {
    const [deployment] = Bun.YAML.parse(
      await Bun.file(join(ROOT, "deploy/local/mailpit.yaml")).text(),
    ) as {
      spec: {
        template: {
          spec: {
            containers: {
              securityContext: { readOnlyRootFilesystem: boolean };
              volumeMounts: { name: string; mountPath: string }[];
            }[];
            volumes: { name: string; emptyDir?: object }[];
          };
        };
      };
    }[];
    const pod = deployment?.spec.template.spec;
    const tmp = pod?.containers[0]?.volumeMounts.find((mount) => mount.mountPath === "/tmp");
    expect(pod?.containers[0]?.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(pod?.volumes.find((volume) => volume.name === tmp?.name)?.emptyDir).toBeDefined();
  });
});
