/**
 * The whole stack on a local Kubernetes cluster (kind), deployed with the same charts
 * and images as every other environment:
 *
 *   bun run k8s:up      create the cluster, build and load the images, install data + stack
 *   bun run k8s:smoke   check the routes through the gateway, then run re-encryption as
 *                       operators do after a key rotation (k8s:up runs it too)
 *   bun run k8s:down    delete the cluster (`bun run docker:clean` also removes the images)
 *
 * Then open http://localhost (email: `kubectl -n boilerplate port-forward
 * svc/mailpit 8025`, then http://localhost:8025).
 *
 * What differs from a cluster: no Argo CD, cert-manager or mail server. KEDA scales the
 * worker, as in the clusters, and k8s:up waits for it to reach Valkey. The data
 * chart generates its own credentials as everywhere; the services' Secrets, which
 * clusters decrypt from SOPS files, are created here once from generated values, in
 * plain text straight into the cluster (never on disk). Email goes to Mailpit over TLS
 * with a certificate authority made here too, since production settings refuse
 * anything else. Needs Docker with at least 8 GB of memory: the image builds and the
 * cluster together need it, and running out makes Docker kill other containers too.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { MINUTE_MS } from "../packages/contracts/src/time";
import { fail, messageOf, ok, ROOT, type Run, runMain, runSync } from "./lib";

const CLUSTER = "boilerplate";
const NAMESPACE = "boilerplate";
const HOST = "localhost";
/** The address the stack sends email from, and signs in to Mailpit as. */
const MAIL_DOMAIN = "boilerplate.localhost";
/** The uploads bucket's public host (deploy/environments/local/data.yaml). */
const FILES_HOST = "files.localhost";
const STACK = "boilerplate";
const DATA = "boilerplate-data";
const IMAGES = ["api", "worker", "notifications", "webhooks", "web", "ai", "migrate"];
const MIN_DOCKER_MEMORY_GB = 8;
const BUILDER = "boilerplate";

const addonFile = z.object({
  repoURL: z.string().min(1),
  chart: z.string().min(1),
  version: z.string().min(1),
  namespace: z.string().min(1),
});

/**
 * Where to install an add-on from, as the clusters install it (deploy/platform/addons),
 * so kind runs the same chart at the same version.
 */
export function addon(name: string, root = ROOT) {
  const file = `deploy/platform/addons/${name}.yaml`;
  const spec = addonFile.safeParse(Bun.YAML.parse(readFileSync(join(root, file), "utf8")));
  if (!spec.success) {
    throw new Error(`${file} needs repoURL, chart, version and namespace`);
  }
  const { repoURL, chart, version, namespace } = spec.data;
  const source = repoURL.startsWith("https://")
    ? [chart, "--repo", repoURL]
    : [`oci://${repoURL}/${chart}`];
  return [...source, "--version", version, "--namespace", namespace];
}

/** What the commands run, wait with and talk to; the tests replace them. */
export interface Cluster {
  run: Run;
  /** Starts a step that runs side by side, its output into a file (a descriptor). */
  start: (
    command: string[],
    options: { cwd: string; stdout: number; stderr: number },
  ) => { exited: Promise<number> };
  sleep: (ms: number) => Promise<unknown>;
  exit: (code: number) => never;
  /** Registers what runs when the process exits (the side-by-side steps' logs go). */
  onExit: (handler: () => void) => unknown;
  env: Record<string, string | undefined>;
  /** Where the gateway listens on this machine (kind maps port 80), and how long to wait. */
  gateway: { port: number; timeoutMs: number };
}

const REAL: Cluster = {
  run: runSync,
  start: Bun.spawn,
  sleep: Bun.sleep,
  exit: process.exit.bind(process),
  onExit: process.once.bind(process, "exit"),
  env: process.env,
  gateway: { port: 80, timeoutMs: 10_000 },
};

type Response = { status: number; headers: Record<string, string | string[] | undefined> };

/** What the smoke test asks the gateway, and what each answer must be. */
const SMOKE_CHECKS: [string, string, (r: Response) => boolean][] = [
  ["web", "/healthz", (r) => r.status === 200],
  ["web page", "/sign-in", (r) => r.status === 200],
  ["api", "/api/v1/system", (r) => r.status === 200],
  ["api auth", "/api/auth/ok", (r) => r.status === 200],
  ["OAuth metadata", "/.well-known/oauth-authorization-server/api/auth", (r) => r.status === 200],
  [
    "AI MCP server",
    "/ai/mcp",
    (r) => r.status === 401 && String(r.headers["www-authenticate"]).includes("resource_metadata"),
  ],
  ["webhooks", "/webhooks/stripe", (r) => r.status === 404 || r.status === 405 || r.status === 400],
];

const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** A Secret in the stack's namespace. */
const secretManifest = (name: string, stringData: Record<string, string>, type = "Opaque") => ({
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name, namespace: NAMESPACE },
  type,
  stringData,
});

/**
 * The services' Secrets' values, generated together: shared values (encryption keys, the
 * service secret) must match.
 */
function serviceSecrets(): Record<string, Record<string, string>> {
  const encryptionKeys = `k1:${randomBytes(32).toString("base64")}`;
  const unsubscribe = secret();
  const aiService = secret();
  // Mailpit takes any login; production settings still want one.
  const smtpUrl = `smtps://no-reply%40${MAIL_DOMAIN}:${secret(16)}@mailpit:1025`;
  return {
    api: {
      BETTER_AUTH_SECRET: secret(),
      ENCRYPTION_KEYS: encryptionKeys,
      UNSUBSCRIBE_SECRET: unsubscribe,
      AI_SERVICE_SECRET: aiService,
    },
    notifications: { UNSUBSCRIBE_SECRET: unsubscribe, SMTP_URL: smtpUrl },
    webhooks: { ENCRYPTION_KEYS: encryptionKeys },
    ai: { AI_SERVICE_SECRET: aiService },
  };
}

/** The local cluster's steps, each with the tools it runs. */
class KindCluster {
  /**
   * CI's runners have room to build every image at once while the cluster comes up; a
   * laptop builds one at a time after it, in a builder whose memory is capped.
   */
  private readonly inCi: boolean;
  private readonly buildMemory: string;
  /** Where steps that run side by side log: a private directory (mkdtemp makes it 0700). */
  private logs: string | undefined;

  constructor(private readonly tools: Cluster) {
    this.inCi = tools.env.CI === "true";
    this.buildMemory = this.inCi ? "8g" : "4g";
  }

  run(command: string, args: string[], options: { input?: string; quiet?: boolean } = {}) {
    const result = this.tools.run(command, args, {
      cwd: ROOT,
      input: options.input,
      stdio: options.quiet || options.input ? "pipe" : "inherit",
    });
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  }

  step(label: string, command: string, args: string[], input?: string) {
    const result = this.run(command, args, { input });
    if (!result.ok) {
      fail(label);
      if (result.stderr) {
        console.error(result.stderr.trim());
      }
      this.tools.exit(1);
    }
    ok(label);
  }

  /**
   * step(), without blocking: steps that don't depend on each other run side by side. The
   * output goes to a file, not a pipe, so a long build never stalls while a blocking step
   * runs; it's shown when the step fails.
   */
  async stepAsync(label: string, command: string, args: string[]) {
    if (!this.logs) {
      const dir = mkdtempSync(join(tmpdir(), "boilerplate-k8s-"));
      this.logs = dir;
      this.tools.onExit(() => rmSync(dir, { recursive: true, force: true }));
    }
    // Created here or not at all ("x"), and read back through the same descriptor rather
    // than reopened by name.
    const fd = openSync(join(this.logs, `${label.replace(/\W+/g, "-")}.log`), "wx+");
    const child = this.tools.start([command, ...args], { cwd: ROOT, stdout: fd, stderr: fd });
    const code = await child.exited;
    if (code !== 0) {
      const output = Buffer.alloc(fstatSync(fd).size);
      readSync(fd, output, 0, output.length, 0);
      closeSync(fd);
      fail(label);
      console.error(output.toString("utf8").trim().split("\n").slice(-80).join("\n"));
      this.tools.exit(1);
    }
    closeSync(fd);
    ok(label);
  }

  kubectl(args: string[], input?: string) {
    return this.run("kubectl", ["--context", `kind-${CLUSTER}`, ...args], { input, quiet: true });
  }

  /** Applies a list of manifests, or fails the run with what kubectl said. */
  private applyList(label: string, items: unknown[]) {
    const result = this.kubectl(
      ["apply", "-f", "-"],
      JSON.stringify({ apiVersion: "v1", kind: "List", items }),
    );
    if (!result.ok) {
      fail(label);
      console.error(result.stderr);
      this.tools.exit(1);
    }
  }

  preflight() {
    const versionArgs: Record<string, string[]> = {
      docker: ["--version"],
      kind: ["version"],
      helm: ["version", "--short"],
      kubectl: ["version", "--client"],
      openssl: ["version"],
    };
    for (const [tool, args] of Object.entries(versionArgs)) {
      if (!this.run(tool, args, { quiet: true }).ok) {
        fail(`${tool} isn't installed`);
        this.tools.exit(1);
      }
    }
    const info = this.run("docker", ["info", "--format", "{{.MemTotal}}"], { quiet: true });
    const memoryGb = Number(info.stdout.trim()) / 1024 ** 3;
    if (!info.ok || memoryGb < MIN_DOCKER_MEMORY_GB - 0.5) {
      fail(
        `Docker has ${memoryGb.toFixed(1)} GB of memory; the cluster needs ${MIN_DOCKER_MEMORY_GB} GB. ` +
          "Raise it in Docker Desktop (Settings → Resources) and try again.",
      );
      this.tools.exit(1);
    }
    ok(`Docker has ${memoryGb.toFixed(1)} GB of memory`);
  }

  /** A certificate authority and Mailpit's certificate from it, made with openssl in `dir`. */
  private signMailpitCertificate(dir: string) {
    const openssl = (command: string) => {
      const result = this.tools.run("openssl", command.split(" "), { cwd: dir });
      if (result.status !== 0) {
        throw new Error(result.stderr);
      }
    };
    writeFileSync(join(dir, "ext"), "subjectAltName=DNS:mailpit\nextendedKeyUsage=serverAuth\n");
    openssl(
      "req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=boilerplate-kind-ca " +
        "-addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign " +
        "-keyout ca.key -out ca.crt",
    );
    openssl("req -newkey rsa:2048 -nodes -subj /CN=mailpit -keyout tls.key -out tls.csr");
    openssl(
      "x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 " +
        "-extfile ext -out tls.crt",
    );
    const read = (file: string) => readFileSync(join(dir, file), "utf8");
    return [
      secretManifest("local-ca", { "ca.crt": read("ca.crt") }),
      secretManifest(
        "mailpit-tls",
        { "tls.crt": read("tls.crt"), "tls.key": read("tls.key") },
        "kubernetes.io/tls",
      ),
    ];
  }

  /**
   * Mailpit's certificate, from a certificate authority of this cluster's own: the
   * notifications service trusts it (`caBundle` in deploy/environments/local/stack.yaml)
   * and checks the certificate, as production requires. Made once; the CA's key is thrown
   * away, so nothing else can be signed with it.
   */
  mailpitCertificate() {
    if (this.kubectl(["-n", NAMESPACE, "get", "secret", "mailpit-tls"]).ok) {
      ok("Mailpit's certificate (exists)");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "boilerplate-kind-"));
    let problem = "";
    try {
      const items = this.signMailpitCertificate(dir);
      const result = this.kubectl(
        ["apply", "-f", "-"],
        JSON.stringify({ apiVersion: "v1", kind: "List", items }),
      );
      if (!result.ok) {
        problem = result.stderr;
      }
    } catch (error) {
      problem = messageOf(error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (problem) {
      fail("Mailpit's certificate");
      console.error(problem);
      this.tools.exit(1);
    }
    ok("Mailpit's certificate");
  }

  /**
   * The services' Secrets (`<release>-<service>`), created once and kept across `k8s:up`
   * runs. Clusters decrypt theirs from deploy/environments/<env>/secrets/; these are
   * generated, and never leave the cluster. The data chart makes the database, Valkey and
   * storage credentials itself.
   */
  secrets() {
    if (this.kubectl(["-n", NAMESPACE, "get", "secret", `${STACK}-api`]).ok) {
      ok("secrets (exist)");
      return;
    }
    const items = Object.entries(serviceSecrets()).map(([service, stringData]) =>
      secretManifest(`${STACK}-${service}`, stringData),
    );
    this.applyList("secrets", items);
    ok(`secrets (${items.length} created)`);
  }

  /** A request through the gateway on port 80, with the site's host name (or another). */
  get(path: string, host = HOST) {
    return new Promise<Response>((resolve, reject) => {
      const { port, timeoutMs } = this.tools.gateway;
      const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
      });
      req.on("error", reject);
      // Rejected here: under Bun, destroy(error) closes the request without emitting it,
      // and a route that never answers would hang the smoke test for good.
      req.setTimeout(timeoutMs, () => {
        reject(new Error("timed out"));
        req.destroy();
      });
      req.end();
    });
  }

  async smoke() {
    let passed = true;
    // The uploads bucket's public host reaches RustFS, which answers its health check.
    const files = await this.get("/health", FILES_HOST).catch(() => ({ status: 0 }));
    if (files.status === 200) {
      ok(`files: ${FILES_HOST}/health → ${files.status}`);
    } else {
      passed = false;
      fail(`files: ${FILES_HOST}/health → ${files.status}`);
    }
    for (const [label, path, expect] of SMOKE_CHECKS) {
      const result = await this.get(path).catch((error: Error) => ({
        status: 0,
        headers: {},
        error,
      }));
      if (expect(result)) {
        ok(`${label}: ${path} → ${result.status}`);
      } else {
        passed = false;
        fail(`${label}: ${path} → ${result.status}`);
      }
    }
    if (!passed) {
      this.tools.exit(1);
    }
    await this.reencrypt();
  }

  /** Waits for a Job to succeed or fail, for up to five minutes; its last status. */
  private async jobStatus(job: string) {
    const deadline = Date.now() + 5 * MINUTE_MS;
    let status = "";
    while (Date.now() < deadline) {
      status = this.kubectl([
        "-n",
        NAMESPACE,
        "get",
        "job",
        job,
        "-o",
        "jsonpath={.status.succeeded},{.status.failed}",
      ]).stdout;
      if (status.startsWith("1") || status.endsWith(",1")) {
        break;
      }
      await this.tools.sleep(2000);
    }
    return status;
  }

  /**
   * Re-encryption runs in the cluster the way an operator runs it after a key rotation
   * (the rotate-secrets skill): a Job created from the stack's suspended CronJob.
   */
  async reencrypt() {
    const job = `reencrypt-${Date.now()}`;
    const created = this.kubectl([
      "-n",
      NAMESPACE,
      "create",
      "job",
      job,
      `--from=cronjob/${STACK}-reencrypt`,
    ]);
    if (!created.ok) {
      fail(`re-encryption: ${created.stderr.trim()}`);
      this.tools.exit(1);
    }
    const status = await this.jobStatus(job);
    const logs = this.kubectl(["-n", NAMESPACE, "logs", `job/${job}`]).stdout.trim();
    if (status.startsWith("1")) {
      ok(
        `re-encryption: ${logs.split("\n").find((line) => line.startsWith("Re-encrypted")) ?? "done"}`,
      );
    } else {
      fail(`re-encryption: job ${job} ${status.endsWith(",1") ? "failed" : "timed out"}`);
      console.error(logs);
      this.tools.exit(1);
    }
  }

  /** `docker buildx bake` for some images, with GitHub's cache in CI when it's reachable. */
  private bake(targets: string[]) {
    return [
      "buildx",
      "bake",
      ...targets,
      "--builder",
      BUILDER,
      "--load",
      "--set",
      "*.args.RELEASE=dev",
      // deploy.yml caches each image's layers on master under <image>-<arch>.
      ...(this.inCi && this.tools.env.ACTIONS_CACHE_URL
        ? targets.flatMap((target) => [
            "--set",
            `${target}.cache-from=type=gha,scope=${target}-amd64`,
          ])
        : []),
    ];
  }

  private load(images: string[]) {
    return this.stepAsync(`${images.join(", ")} loaded into the cluster`, "kind", [
      "load",
      "docker-image",
      "--name",
      CLUSTER,
      ...images.map((image) => `boilerplate/${image}:dev`),
    ]);
  }

  /**
   * Every image, as boilerplate/<image>:dev, in a builder of our own: its memory is capped
   * (a build can't starve other containers) and its cache goes away with
   * `bun run docker:clean`. In CI all at once, reading the layers deploy.yml caches on
   * master when GitHub's cache is reachable, each loaded into the cluster as soon as it's
   * built and the cluster exists; locally one image at a time, loaded together after.
   */
  async buildImages(cluster: Promise<void>) {
    if (!this.run("docker", ["buildx", "inspect", BUILDER], { quiet: true }).ok) {
      this.step("image builder", "docker", [
        "buildx",
        "create",
        "--name",
        BUILDER,
        "--driver",
        "docker-container",
        "--driver-opt",
        `memory=${this.buildMemory}`,
        "--driver-opt",
        "default-load=true",
      ]);
    }
    if (this.inCi) {
      // Concurrent builds share the builder's cache, so common layers still build once.
      await Promise.all(
        IMAGES.map(async (image) => {
          await this.stepAsync(`image ${image}`, "docker", this.bake([image]));
          await cluster;
          await this.load([image]);
        }),
      );
      return;
    }
    for (const image of IMAGES) {
      await this.stepAsync(`image ${image}`, "docker", this.bake([image]));
    }
    await cluster;
    await this.load(IMAGES);
  }

  /** `helm upgrade --install` of an add-on, as the clusters install it. */
  private addon(label: string, release: string, name: string, extra: string[] = []) {
    return this.stepAsync(label, "helm", [
      "upgrade",
      "--install",
      release,
      ...addon(name),
      ...extra,
      "--create-namespace",
      "--kube-context",
      `kind-${CLUSTER}`,
      "--wait",
    ]);
  }

  /** The namespaces, certificates, Secrets, gateway and Mailpit the charts expect. */
  private foundations() {
    this.kubectl(["create", "namespace", "gateway-system"]);
    this.kubectl(["create", "namespace", NAMESPACE]);
    this.mailpitCertificate();
    this.secrets();
    for (const [label, file] of [
      ["gateway", "deploy/local/gateway.yaml"],
      ["mailpit", "deploy/local/mailpit.yaml"],
    ] as const) {
      this.step(label, "kubectl", ["--context", `kind-${CLUSTER}`, "apply", "-f", file]);
    }
  }

  /** One of our charts, with the local environment's values. */
  private chart(
    label: string,
    release: string,
    chart: string,
    timeout: string,
  ): [string, string, string[]] {
    return [
      label,
      "helm",
      [
        "upgrade",
        "--install",
        release,
        join(ROOT, `deploy/charts/${chart}`),
        "-f",
        join(ROOT, `deploy/environments/local/${chart}.yaml`),
        "--namespace",
        NAMESPACE,
        "--kube-context",
        `kind-${CLUSTER}`,
        "--wait",
        "--timeout",
        timeout,
      ],
    ];
  }

  async up() {
    this.preflight();
    const exists = this.run("kind", ["get", "clusters"], { quiet: true }).stdout.split("\n");
    const cluster = exists.includes(CLUSTER)
      ? Promise.resolve(ok("cluster (exists)"))
      : this.stepAsync("cluster", "kind", [
          "create",
          "cluster",
          "--config",
          "deploy/local/kind.yaml",
        ]);
    // Only our charts need our images: in CI they build while the cluster gets ready.
    const images = this.inCi ? this.buildImages(cluster) : undefined;
    await cluster;
    await Promise.all([
      this.addon("Envoy Gateway", "eg", "envoy-gateway"),
      this.addon("CloudNativePG", "cnpg", "cloudnative-pg"),
      this.addon("KEDA", "keda", "keda", ["-f", join(ROOT, "deploy/platform/values/keda.yaml")]),
    ]);
    this.foundations();
    const data = () =>
      this.stepAsync(
        ...this.chart(
          "data (Postgres, Valkey, RustFS; credentials generated)",
          DATA,
          "data",
          "10m",
        ),
      );
    if (images === undefined) {
      await this.buildImages(cluster);
      await data();
    } else {
      await Promise.all([images, data()]);
    }
    this.step("Postgres ready", "kubectl", [
      "--context",
      `kind-${CLUSTER}`,
      "-n",
      NAMESPACE,
      "wait",
      `cluster/${DATA}-postgres`,
      "--for=condition=Ready",
      "--timeout=10m",
    ]);
    this.step(...this.chart("stack (migrations, then every service)", STACK, "stack", "15m"));
    // Ready only once KEDA's operator has read the worker's queues from Valkey.
    this.step("KEDA scales the worker on its queues", "kubectl", [
      "--context",
      `kind-${CLUSTER}`,
      "-n",
      NAMESPACE,
      "wait",
      `scaledobject/${STACK}-worker`,
      "--for=condition=Ready",
      "--timeout=5m",
    ]);
    await this.smoke();
    console.log(`\n  http://${HOST}`);
  }
}

/** `up`, `smoke` or `down` (argv's first word); the exit code. */
export async function k8s(argv = process.argv.slice(2), given: Partial<Cluster> = {}) {
  const cluster = new KindCluster({ ...REAL, ...given });
  const command = argv[0];
  if (command === "up") {
    await cluster.up();
  } else if (command === "smoke") {
    await cluster.smoke();
  } else if (command === "down") {
    cluster.step("cluster deleted", "kind", ["delete", "cluster", "--name", CLUSTER]);
  } else {
    console.error("usage: bun scripts/k8s.ts up | smoke | down");
    return 1;
  }
  return 0;
}

await runMain(import.meta, k8s);
