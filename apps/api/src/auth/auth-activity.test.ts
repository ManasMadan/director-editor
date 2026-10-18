import { YOUTUBE_UPLOAD_SCOPE } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import {
  type AuthAnswer,
  failedAuthActivity,
  googleLinked,
  sessionEnded,
  signInMethod,
} from "./auth-activity";

describe("how someone signed in", () => {
  it.each([
    ["/sign-in/email", "password"],
    ["/sign-in/email-otp", "email-code"],
    ["/callback/:id", "google"],
    ["/passkey/verify-authentication", "passkey"],
    [undefined, "other"],
  ] as const)("from %s is %s", (path, method) => {
    expect(signInMethod(path, false)).toBe(method);
  });

  it("is the demo account, whichever way it came in", () => {
    expect(signInMethod("/sign-in/email", true)).toBe("demo");
  });
});

describe("a session that ended", () => {
  it("was signed out of, or revoked with its reason", () => {
    expect(sessionEnded("/sign-out", "u-1")).toEqual({
      activity: "auth.signed_out",
      target: { userId: "u-1" },
    });
    expect(sessionEnded("/change-password", "u-1")).toEqual({
      activity: "auth.session_revoked",
      target: { userId: "u-1", reason: "password-change" },
    });
  });
});

describe("a linked account", () => {
  it("is logged for Google, with its grant to upload when it has one", () => {
    expect(googleLinked({ providerId: "credential" })).toEqual([]);
    expect(
      googleLinked({ providerId: "google", scope: "openid,email" }).map((line) => line.activity),
    ).toEqual(["auth.google_linked"]);
    expect(
      googleLinked({ providerId: "google", scope: `openid,${YOUTUBE_UPLOAD_SCOPE}` }).map(
        (line) => line.activity,
      ),
    ).toEqual(["auth.google_linked", "auth.youtube_granted"]);
  });
});

describe("an auth answer that went wrong", () => {
  const answer = (fields: Partial<AuthAnswer>): AuthAnswer => ({
    path: "/sign-in/email",
    status: 401,
    code: "INVALID_EMAIL_OR_PASSWORD",
    location: null,
    body: Buffer.from(JSON.stringify({ email: "ada@example.com", password: "hunter22" })),
    ...fields,
  });

  it("is a failed sign-in naming the address tried, never the password", () => {
    const line = failedAuthActivity(answer({}));
    expect(line).toEqual({
      activity: "auth.signed_in",
      outcome: "failed",
      reason: "INVALID_EMAIL_OR_PASSWORD",
      actor: { email: "ada@example.com" },
      target: { method: "password" },
    });
    expect(JSON.stringify(line)).not.toContain("hunter22");
  });

  it("is a refused one when there were too many tries", () => {
    expect(
      failedAuthActivity(answer({ path: "/sign-in/email-otp", status: 429, code: undefined })),
    ).toMatchObject({
      outcome: "refused",
      reason: "RATE_LIMITED",
      target: { method: "email-code" },
    });
  });

  it("is a failed sign-up, and keeps the status when there's no code", () => {
    expect(
      failedAuthActivity(answer({ path: "/sign-up/email", status: 400, code: undefined })),
    ).toMatchObject({ activity: "auth.signed_up", reason: "HTTP_400" });
  });

  it("names no one when the body isn't JSON with an address", () => {
    // The last: a password typed into the address field by mistake is never logged.
    const typo = Buffer.from(JSON.stringify({ email: "hunter22", password: "x" }));
    for (const body of [Buffer.from("not json"), Buffer.from("{}"), undefined, typo]) {
      expect(failedAuthActivity(answer({ body }))).not.toHaveProperty("actor");
    }
  });

  it("keeps Google's error only when it's a code, since anyone can write the URL", () => {
    const location = `/sign-in?error=${encodeURIComponent("<script>alert(1)</script>")}`;
    expect(
      failedAuthActivity(answer({ path: "/callback/google", status: 302, location })),
    ).toMatchObject({ reason: "unreadable_error" });
  });

  it("is a failed Google sign-in when its callback comes back with an error", () => {
    expect(
      failedAuthActivity(
        answer({
          path: "/callback/google",
          status: 302,
          code: undefined,
          location: "https://director.example.com/sign-in?error=access_denied",
        }),
      ),
    ).toEqual({
      activity: "auth.signed_in",
      outcome: "failed",
      reason: "access_denied",
      target: { method: "google" },
    });
  });

  it("is the demo account refused, wherever it was", () => {
    expect(
      failedAuthActivity(
        answer({ path: "/change-password", status: 403, code: "DEMO_ACCOUNT_LOCKED" }),
      ),
    ).toEqual({
      activity: "auth.demo_refused",
      outcome: "refused",
      reason: "DEMO_ACCOUNT_LOCKED",
      target: { path: "/change-password" },
    });
  });

  it("is nothing for a success, a Google callback that worked, or another endpoint", () => {
    expect(failedAuthActivity(answer({ status: 200, code: undefined }))).toBeNull();
    expect(
      failedAuthActivity(
        answer({ path: "/callback/google", status: 302, code: undefined, location: "/director" }),
      ),
    ).toBeNull();
    expect(
      failedAuthActivity(answer({ path: "/callback/google", status: 302, code: undefined })),
    ).toBeNull();
    expect(failedAuthActivity(answer({ path: "/get-session", status: 401 }))).toBeNull();
  });
});
