/**
 * The local services have well-known passwords (or none) and Mailpit shows every
 * sign-in code, so every port docker compose publishes listens on localhost unless the
 * developer opens it on purpose (DOCKER_BIND_ADDRESS).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const compose = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../docker-compose.yml"), "utf8"),
) as {
  services: Record<string, { ports?: string[] }>;
};

describe("docker-compose.yml", () => {
  const published = Object.entries(compose.services).flatMap(([name, service]) =>
    (service.ports ?? []).map((port) => ({ name, port })),
  );

  it("publishes ports", () => {
    expect(published.length).toBeGreaterThan(0);
  });

  it.each(published)("$name publishes $port on localhost by default", ({ port }) => {
    expect(port).toMatch(/^\$\{DOCKER_BIND_ADDRESS:-127\.0\.0\.1\}:/);
  });
});

describe("the images docker compose runs", () => {
  const images = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "../docker-compose.yml"), "utf8"),
  ) as { services: Record<string, { image?: string }> };
  /** A YAML file of the repository, as the shape the caller names. */
  function read<T>(file: string): T {
    return Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", file), "utf8")) as T;
  }
  const data = read("deploy/charts/data/values.yaml") as {
    valkey: { image: string };
    storage: { image: string; buckets: { image: string } };
  };
  const stack = read("deploy/charts/stack/values.yaml") as {
    services: { clamav: { imageRef: string } };
  };
  const mail = read("deploy/platform/mail/values.yaml") as {
    image: string;
    cli: { image: string };
  };
  const jaeger = read("deploy/platform/jaeger/values.yaml") as { image: string };
  const mailpit = readFileSync(join(import.meta.dir, "../deploy/local/mailpit.yaml"), "utf8");

  // Each local service, and the image the clusters run for it. Postgres is the one
  // exception: CloudNativePG needs its own images, which don't start on their own.
  const clusters: Record<string, string> = {
    valkey: data.valkey.image,
    rustfs: data.storage.image,
    "s3-init": data.storage.buckets.image,
    clamav: stack.services.clamav.imageRef,
    stalwart: mail.image,
    "stalwart-init": mail.cli.image,
    jaeger: jaeger.image,
    mailpit: /image: (\S+)/.exec(mailpit)?.[1] ?? "",
  };
  const bare = (image: string) => image.replace(/^docker\.io\//, "");

  it.each(Object.entries(clusters))("%s is the image the clusters run", (service, image) => {
    expect(bare(images.services[service]?.image ?? "")).toBe(bare(image));
  });
});
