import { describe, expect, it } from "vitest";
import * as client from "./index";

describe("the package entry", () => {
  it("exposes the client, its errors, the provider and live updates", () => {
    expect(Object.keys(client)).toEqual(
      expect.arrayContaining([
        "createApiClient",
        "errorCode",
        "errorMessageKey",
        "fieldErrors",
        "ApiProvider",
        "useApi",
        "useLiveUpdates",
        "useRealtime",
      ]),
    );
  });
});
