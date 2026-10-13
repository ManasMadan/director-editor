import { expect, it } from "vitest";
import { GET } from "./route";

it("answers the health probe without touching the API", async () => {
  const response = GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
