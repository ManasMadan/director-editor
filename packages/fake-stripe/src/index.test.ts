import { describe, expect, it } from "vitest";
import { parseForm } from "./index";

describe("parseForm", () => {
  it("decodes Stripe's bracketed form encoding", () => {
    expect(
      parseForm(
        "customer=cus_1&line_items[0][price]=price_1&line_items[0][quantity]=3&subscription_data[metadata][orgId]=o1&metadata[a]=b",
      ),
    ).toEqual({
      customer: "cus_1",
      line_items: [{ price: "price_1", quantity: "3" }],
      subscription_data: { metadata: { orgId: "o1" } },
      metadata: { a: "b" },
    });
  });
});
