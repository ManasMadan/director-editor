import { describe, expect, it } from "vitest";
import * as z from "zod";
import { row, rows } from "./sql";

const id = z.object({ id: z.string() });

describe("raw SQL results", () => {
  it("come back typed when the columns are what the code expects", async () => {
    expect(await rows(id, Promise.resolve([{ id: "a" }, { id: "b" }]))).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
    expect(await row(z.object({ n: z.bigint() }), Promise.resolve([{ n: 3n }]))).toEqual({ n: 3n });
  });

  it("fail at the query when a column changed, or a single row isn't one", async () => {
    await expect(rows(id, Promise.resolve([{ uuid: "a" }]))).rejects.toThrow("id");
    await expect(row(id, Promise.resolve([]))).rejects.toThrow();
    await expect(row(id, Promise.resolve([{ id: "a" }, { id: "b" }]))).rejects.toThrow();
  });
});
