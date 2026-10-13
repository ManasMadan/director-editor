import { afterEach, describe, expect, it, vi } from "vitest";
import { ClamdScanner, NoScanner } from "./file-scanner";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function scanner(variables: Record<string, string>) {
  for (const [key, value] of Object.entries(variables)) {
    vi.stubEnv(key, value);
  }
  return (await import("./files.module")).createScanner();
}

describe("the upload scanner", () => {
  it("is off when development asks for none", async () => {
    const none = await scanner({ FILE_SCANNER: "none" });
    expect(none).toBeInstanceOf(NoScanner);
    expect(await none.scan(Buffer.from("x"))).toEqual({ clean: true });
  });

  it("is clamd at CLAMAV_URL, on clamd's own port unless it names one", async () => {
    expect(await scanner({ FILE_SCANNER: "clamav", CLAMAV_URL: "tcp://clamav" })).toEqual(
      new ClamdScanner("clamav", 3310),
    );
    vi.resetModules();
    expect(await scanner({ FILE_SCANNER: "clamav", CLAMAV_URL: "tcp://clamav:53310" })).toEqual(
      new ClamdScanner("clamav", 53310),
    );
  });
});
