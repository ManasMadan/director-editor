import { expect, it } from "vitest";
import { request } from "../../test/next-server";
import { pageTitle } from "./metadata";

it("titles a page in the request's language", async () => {
  expect(await pageTitle("common.dashboard")()).toEqual({ title: "Dashboard" });
  request.cookies.set("locale", "es");
  expect(await pageTitle("common.dashboard")()).toEqual({ title: "Panel" });
});
