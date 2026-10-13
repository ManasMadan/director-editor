/** The contract's pure helpers, which web, mobile and every service share. */
import { describe, expect, it } from "vitest";
import { isErrorCode } from "./errors";
import { fileContentPath } from "./files";
import { fileIdSchema } from "./ids";
import { AI_MCP_PATH, MCP_PATH, mcpResource } from "./mcp";
import { formatMoney } from "./money";
import { entriesOf, fieldOf, hasKey, keysOf, required } from "./objects";
import { pageInput, toPage } from "./pagination";

describe("toPage", () => {
  const rows = ["a", "b", "c"].map((id) => ({ id }));

  it("returns a cursor only when another page exists (the extra row)", () => {
    expect(toPage(rows, 2)).toEqual({ items: rows.slice(0, 2), nextCursor: "b" });
    expect(toPage(rows, 3)).toEqual({ items: rows, nextCursor: null });
    expect(toPage([], 20)).toEqual({ items: [], nextCursor: null });
    // No items to point at: nothing to continue from.
    expect(toPage(rows, 0)).toEqual({ items: [], nextCursor: null });
  });

  it("bounds the page size", () => {
    expect(pageInput.parse({})).toEqual({ limit: 20 });
    expect(pageInput.safeParse({ limit: 101 }).success).toBe(false);
    expect(pageInput.safeParse({ limit: 0 }).success).toBe(false);
    expect(pageInput.safeParse({ cursor: "not-a-uuid" }).success).toBe(false);
  });
});

describe("formatMoney", () => {
  it("converts minor units by the currency's own digits", () => {
    expect(formatMoney({ amount: 1999, currency: "USD" }, "en")).toBe("$19.99");
    expect(formatMoney({ amount: 1999, currency: "JPY" }, "en")).toBe("¥1,999");
    // Intl separates the amount and the symbol with a no-break space.
    expect(formatMoney({ amount: 1999, currency: "EUR" }, "es")).toBe("19,99\u00a0€");
  });
});

describe("isErrorCode", () => {
  it("knows the catalog's codes and nothing else", () => {
    expect(isErrorCode("TODO_NOT_FOUND")).toBe(true);
    expect(isErrorCode("NOT_A_CODE")).toBe(false);
    expect(isErrorCode("toString")).toBe(false);
    expect(isErrorCode(404)).toBe(false);
  });
});

describe("resource paths", () => {
  it("names each MCP server on the site's origin, without a double slash", () => {
    expect(mcpResource("https://app.example.com/", MCP_PATH)).toBe(
      "https://app.example.com/api/mcp",
    );
    expect(mcpResource("https://app.example.com", AI_MCP_PATH)).toBe(
      "https://app.example.com/ai/mcp",
    );
  });

  it("serves a file's content under the REST API", () => {
    const fileId = fileIdSchema.parse("0199a3c4-0000-7000-8000-0000000000f1");
    expect(fileContentPath(fileId)).toBe(`/api/v1/files/${fileId}/content`);
  });
});

describe("keysOf, entriesOf and hasKey", () => {
  it("see an object's own keys only, not inherited ones", () => {
    const object = Object.assign(Object.create({ inherited: 1 }), { a: 1, b: 2 });
    expect(keysOf(object)).toEqual(["a", "b"]);
    expect(entriesOf({ a: 1, b: 2 })).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(hasKey({ a: 1 }, "a")).toBe(true);
    expect(hasKey({ a: 1 }, "toString")).toBe(false);
  });
});

describe("fieldOf", () => {
  it("reads a field of anything thrown, own or inherited, and undefined otherwise", () => {
    expect(fieldOf(Object.assign(new Error("x"), { code: "EPERM" }), "code")).toBe("EPERM");
    expect(fieldOf(new TypeError("x"), "name")).toBe("TypeError");
    expect(fieldOf({}, "code")).toBeUndefined();
    expect(fieldOf("EPERM", "code")).toBeUndefined();
    expect(fieldOf(null, "code")).toBeUndefined();
  });
});

describe("required", () => {
  it("returns a present value, falsy ones too, and names a missing one", () => {
    expect(required(0, "count")).toBe(0);
    expect(required("", "name")).toBe("");
    expect(() => required(undefined, "the first key")).toThrow("the first key is missing");
    expect(() => required(null, "url")).toThrow("url is missing");
  });
});
