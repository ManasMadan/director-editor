import { expect, it } from "vitest";
import { request } from "../../test/next-server";
import { pageTitle } from "./metadata";

it("titles a page in the request's language", async () => {
  request.cookies.set("locale", "en");
  expect(await pageTitle("common.library")()).toEqual({ title: "Library" });
});
