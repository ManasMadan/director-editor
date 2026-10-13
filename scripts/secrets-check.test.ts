import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSecrets, isPlatformSecret, recipientsFor, unsafeSecret } from "./secrets-check";
import { captureOutput } from "./stand-ins";

afterEach(() => mock.restore());

const secret = (value: string, extra = "") =>
  `apiVersion: v1\nkind: Secret\nmetadata:\n  name: boilerplate-api\n${extra}stringData:\n  BETTER_AUTH_SECRET: ${value}\n`;
const sops =
  "sops:\n  age:\n    - recipient: age1example\n      enc: x\n  mac: ENC[AES256_GCM,data:m,iv:i,tag:t,type:str]\n";
const encrypted = `${secret("ENC[AES256_GCM,data:abc,iv:def,tag:ghi,type:str]")}${sops}`;

describe("the secrets check", () => {
  it("passes a Secret SOPS encrypted with age", () => {
    expect(unsafeSecret("api.sops.yaml", encrypted, false)).toBeNull();
  });

  it("refuses values in plain text, even with SOPS metadata", () => {
    expect(unsafeSecret("api.sops.yaml", secret("hunter2"), false)).toContain("not encrypted");
    expect(unsafeSecret("api.sops.yaml", `${secret("hunter2")}${sops}`, false)).toBe(
      "values in plain text: BETTER_AUTH_SECRET",
    );
    expect(
      unsafeSecret("api.sops.yaml", `${secret("ENC[AES256_GCM,x]")}sops: {}\n`, false),
    ).toContain("not encrypted");
  });

  it("refuses files that aren't encrypted Secrets", () => {
    expect(unsafeSecret("api.yaml", encrypted, false)).toBe("only *.sops.yaml files belong here");
    expect(unsafeSecret("api.sops.yaml", "kind: ConfigMap\n", false)).toBe("not a Secret");
    expect(unsafeSecret("api.sops.yaml", "a: [", false)).toContain("not YAML");
    expect(unsafeSecret("api.sops.yaml", "- a\n- b\n", false)).toBe("not one YAML document");
    expect(
      unsafeSecret(
        "api.sops.yaml",
        `apiVersion: v1\nkind: Secret\nmetadata:\n  name: boilerplate-api\nstringData: {}\n${sops}`,
        false,
      ),
    ).toBe("has no values");
    expect(unsafeSecret(".gitkeep", "", false)).toBeNull();
    expect(unsafeSecret(".gitkeep", "x", false)).toBe(".gitkeep must be empty");
  });

  it("keeps namespaces where they belong", () => {
    expect(unsafeSecret("api.sops.yaml", encrypted, true)).toBe(
      "a platform Secret names its namespace",
    );
    const namespaced = `${secret("ENC[AES256_GCM,data:a,iv:b,tag:c,type:str]", "  namespace: mail\n")}${sops}`;
    expect(unsafeSecret("stalwart.sops.yaml", namespaced, true)).toBeNull();
    expect(unsafeSecret("api.sops.yaml", namespaced, false)).toContain("names no namespace");
  });

  it("tells platform Secrets from the application's by path", () => {
    expect(isPlatformSecret("deploy/platform/secrets/staging/stalwart.sops.yaml")).toBe(true);
    expect(isPlatformSecret("deploy/environments/staging/secrets/api.sops.yaml")).toBe(false);
  });

  it("refuses a file encrypted to other keys than its directory's", () => {
    expect(unsafeSecret("api.sops.yaml", encrypted, false, ["age1example"])).toBeNull();
    expect(unsafeSecret("api.sops.yaml", encrypted, false, ["age1preview", "age1you"])).toContain(
      "not the keys .sops.yaml names for this directory",
    );
  });

  it("gives previews keys of their own, never the staging cluster's", () => {
    const config = readFileSync(join(import.meta.dir, "../.sops.yaml"), "utf8");
    const preview = recipientsFor("deploy/environments/preview/secrets/api.sops.yaml", config);
    const staging = recipientsFor("deploy/environments/staging/secrets/api.sops.yaml", config);
    expect(preview).toEqual(["age1previewpublickeyreplaceme", "age1yourpublickeyreplaceme"]);
    expect(staging).toContain("age1stagingclusterpublickeyreplaceme");
    expect(preview).not.toContain("age1stagingclusterpublickeyreplaceme");
    expect(recipientsFor("README.md", config)).toBeUndefined();
  });
});

describe("the check over staged files", () => {
  it("names each unsafe file and fails, and passes safe ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-"));
    const safe = join(dir, "api.sops.yaml");
    const plain = join(dir, "web.sops.yaml");
    writeFileSync(safe, encrypted);
    writeFileSync(plain, secret("hunter2"));
    const printed = captureOutput();
    expect(checkSecrets([safe], "creation_rules: []\n")).toBe(0);
    expect(printed()).toBe("");
    expect(checkSecrets([safe, plain], "creation_rules: []\n")).toBe(1);
    expect(printed()).toContain(`${plain}: not encrypted`);
    expect(printed()).not.toContain(safe);
  });

  it("reads the repository's .sops.yaml by default", () => {
    expect(checkSecrets([])).toBe(0);
  });
});
