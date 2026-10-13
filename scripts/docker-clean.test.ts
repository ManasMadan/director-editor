import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanDocker } from "./docker-clean";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

/** A machine with everything docker:clean removes, and a few things it must keep. */
function everythingThere(line: string) {
  if (line === "kind get clusters") {
    return { stdout: "other\ndirector-editor\n" };
  }
  if (line.includes("reference=director-editor/*")) {
    return { stdout: "director-editor/api:dev\n" };
  }
  if (line.endsWith("config --images")) {
    return { stdout: "postgres:18\nvalkey/valkey:9\n" };
  }
  if (line.includes("reference=vsc-director-editor-*")) {
    return { stdout: "vsc-director-editor-1:latest\n" };
  }
  if (line.includes("reference=kindest/node")) {
    return { stdout: "kindest/node:v1\n" };
  }
  if (line === "docker image inspect grafana/k6:2.3.0") {
    return { status: 1 };
  }
  if (line.includes("ancestor=postgres:18")) {
    return { stdout: "other-db\n" };
  }
  if (line === "docker image rm valkey/valkey:9") {
    return { status: 1 };
  }
  return {};
}

describe("docker:clean", () => {
  it("removes the services, the cluster, the builder and the repo's unused images", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun(everythingThere);
    cleanDocker(run);
    expect(calls).toContain("kind delete cluster --name director-editor");
    expect(calls).toContain("docker buildx rm --force director-editor");
    expect(calls).toContain("docker image rm director-editor/api:dev");
    expect(calls).toContain("docker image rm kindest/node:v1");
    expect(calls).toContain("docker image rm vsc-director-editor-1:latest");
    // Not there, or another container still runs on it: left alone.
    expect(calls).not.toContain("docker image rm grafana/k6:2.3.0");
    expect(calls).not.toContain("docker image rm postgres:18");
    const output = printed();
    expect(output).toContain("local services, their networks and volumes");
    expect(output).toContain("kind cluster director-editor");
    expect(output).toContain("image builder director-editor and its cache");
    expect(output).toContain("kept postgres:18: used by other-db");
    expect(output).toContain("couldn't remove valkey/valkey:9");
    expect(output).toContain("image director-editor/api:dev");
  });

  it("skips what isn't there: no services, no cluster, no builder, no images", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun((line) => {
      if (line.startsWith("docker images") || line.endsWith("config --images")) {
        return {};
      }
      return line === "kind get clusters" ? { stdout: "other\n" } : { status: 1 };
    });
    cleanDocker(run);
    expect(calls.filter((line) => / (delete|rm) /.test(line))).toEqual([]);
    expect(printed()).toBe("");
  });
});
