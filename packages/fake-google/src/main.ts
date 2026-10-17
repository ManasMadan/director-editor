/**
 * Runs the mock Google by hand (`bun run google:fake`); test suites start it themselves
 * instead, in-process (apps/web/test/global-setup.ts and similar). Its key is whatever
 * GOOGLE_API_KEY and YOUTUBE_API_KEY say in .env; both must match.
 */
import { startFakeGoogle } from "./index";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set to run the mock Google`);
  }
  return value;
};

const apiKey = required("GOOGLE_API_KEY");
if (required("YOUTUBE_API_KEY") !== apiKey) {
  throw new Error("The mock Google takes one key: set GOOGLE_API_KEY and YOUTUBE_API_KEY alike");
}
export const fake = await startFakeGoogle({ apiKey, port: Number(required("GOOGLE_FAKE_PORT")) });
process.stdout.write(`mock Google (Gemini and YouTube) on ${fake.url}\n`);
