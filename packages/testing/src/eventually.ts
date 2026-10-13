import { inspect } from "node:util";
import { vi } from "vitest";

interface Options {
  timeout?: number;
  interval?: number;
}

/**
 * Reads until `done` accepts what it read, and returns that; fails after `timeout` ms with
 * the last value read. For waiting on work a service does in the background (a job, a
 * row, an email), instead of sleeping for a while and hoping it's done.
 */
export function eventually<T, D extends T>(
  read: () => T | Promise<T>,
  done: (value: T) => value is D,
  options?: Options,
): Promise<D>;
export function eventually<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  options?: Options,
): Promise<T>;
export function eventually<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  { timeout = 15_000, interval = 50 }: Options = {},
): Promise<T> {
  return vi.waitFor(
    async () => {
      const value = await read();
      if (!done(value)) {
        throw new Error(`still waiting, last read: ${inspect(value, { depth: 2 })}`);
      }
      return value;
    },
    { timeout, interval },
  );
}
