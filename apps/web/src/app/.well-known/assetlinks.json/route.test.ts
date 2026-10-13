import { expect, it } from "vitest";
import { GET } from "./route";

it("answers 404 without the mobile app's identifiers (src/lib/app-links.test.ts has the file)", () => {
  expect(GET().status).toBe(404);
});
