/**
 * The secrets a local environment is generated with: by `bun run setup` for `.env`, and
 * for every test run (./environment.ts). `.env.example` carries placeholders for them.
 */
import { randomBytes } from "node:crypto";

/** A value in `.env.example` that must be replaced before anything uses it. */
export const PLACEHOLDER = /^(change-me.*|replace-me.*)$/;

/** A fresh random secret: 32 random bytes, base64url. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** `values` with every placeholder replaced by a generated secret. */
export function fillPlaceholders(values: Record<string, string>): Record<string, string> {
  const filled = { ...values };
  for (const [key, value] of Object.entries(filled)) {
    if (PLACEHOLDER.test(value)) {
      filled[key] = newSecret();
    }
  }
  return filled;
}
