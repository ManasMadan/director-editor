/**
 * The breached-password check (PASSWORD_BREACH_CHECK=on, production's default) against
 * a stand-in for Have I Been Pwned's range API, which has no local fake: only the SHA-1
 * prefix leaves, a breached password is refused, and while the service is down
 * sign-ups fail rather than let a password through unchecked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi } from "./harness";

let harness: Harness;
beforeAll(async () => {
  harness = await startApi(17, { PASSWORD_BREACH_CHECK: "on" });
});
afterAll(() => harness.close());
afterEach(() => vi.restoreAllMocks());

const RANGE = "https://api.pwnedpasswords.com/range/";

/** Answers HIBP's range requests with `answer`; every other request goes out as usual. */
function pwnedPasswords(answer: (prefix: string) => Response) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(RANGE)) {
      return real(input, init);
    }
    asked.push(url.slice(RANGE.length));
    return Promise.resolve(answer(url.slice(RANGE.length)));
  });
  return asked;
}

/**
 * A fixed password and its SHA-1, worked out once (`printf %s ... | shasum`): HIBP's range
 * API is SHA-1 by design. A known pair, not a hash computed here, so the test states the
 * exact prefix that leaves and suffix that matches.
 */
const KNOWN = {
  password: "Pw-breach-check-test-vector",
  prefix: "609F9",
  suffix: "DBD5D99C18CDF4FDCEA96F2F05570BECA2C",
};
const signUp = (password: string) =>
  createSession(harness).auth<{ code?: string }>("/sign-up/email", {
    email: newEmail(),
    password,
    name: "Breach",
  });

describe("the breached-password check", () => {
  it("sends only the hash's first five characters, and lets a clean password through", async () => {
    const asked = pwnedPasswords(() => new Response("0000000000000000000000000000000000A:3\n"));
    expect((await signUp(KNOWN.password)).status).toBe(200);
    expect(asked).toEqual([KNOWN.prefix]);
  });

  it("refuses a password found in a breach", async () => {
    pwnedPasswords(() => new Response(`${KNOWN.suffix}:12\n`));
    const refused = await signUp(KNOWN.password);
    expect(refused.status).toBe(400);
    expect(refused.body?.code).toBe("PASSWORD_COMPROMISED");
  });

  it("refuses to sign anyone up while the service can't be reached", async () => {
    pwnedPasswords(() => new Response("unavailable", { status: 503 }));
    const failed = await signUp(newPassword());
    expect(failed.status).toBe(500);
  });
});
