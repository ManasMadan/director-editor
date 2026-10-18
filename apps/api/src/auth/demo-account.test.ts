import { describe, expect, it } from "vitest";
import { demoCommand } from "./demo-account";

describe("what director:demo-account is asked to do", () => {
  it("runs in production as it is, and elsewhere only with --force", () => {
    expect(demoCommand([], "production", "a-demo-password")).toEqual({
      password: "a-demo-password",
      reset: false,
    });
    expect(demoCommand(["--force", "--reset"], "development", "a-demo-password")).toEqual({
      password: "a-demo-password",
      reset: true,
    });
    expect(demoCommand(["--reset"], "test", "a-demo-password")).toEqual({
      refused: expect.stringContaining("pass --force"),
    });
  });

  it("needs the password, and only the options it knows", () => {
    expect(demoCommand([], "production", undefined)).toEqual({
      refused: expect.stringContaining("DEMO_PASSWORD isn't set"),
    });
    expect(demoCommand(["--force", "-f"], "production", "a-demo-password")).toEqual({
      refused: "Unknown option -f. Options: --force, --reset.",
    });
  });
});
