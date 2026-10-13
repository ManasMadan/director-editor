import { describe, expect, it } from "vitest";
import { request } from "../../test/next-server";
import getRequestConfig from "./request";

const config = () => getRequestConfig({ requestLocale: Promise.resolve(undefined) });

describe("the request's language and time zone", () => {
  it("come from the user's cookies", async () => {
    request.cookies.set("locale", "es");
    request.cookies.set("tz", "Europe/Madrid");
    const { locale, timeZone, messages } = await config();
    expect({ locale, timeZone }).toEqual({ locale: "es", timeZone: "Europe/Madrid" });
    expect(messages).toMatchObject({ common: { signIn: "Iniciar sesión" } });
  });

  it("fall back to the browser's languages, and UTC", async () => {
    request.cookies.set("locale", "klingon");
    request.headers.set("accept-language", "es-MX,es;q=0.9,en;q=0.8");
    expect(await config()).toMatchObject({ locale: "es", timeZone: "UTC" });
  });

  it("are English without either", async () => {
    expect(await config()).toMatchObject({ locale: "en" });
  });
});
