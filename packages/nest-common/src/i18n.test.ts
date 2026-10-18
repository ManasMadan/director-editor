import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { bundledMessages, type I18n } from "@repo/i18n";
import { describe, expect, it } from "vitest";
import { I18nModule, InjectI18n } from "./i18n";

/** A service that uses translations, the way services inject them. */
@Injectable()
class Mailer {
  constructor(@InjectI18n() readonly i18n: I18n) {}
}

async function translatorFrom(module: ReturnType<typeof I18nModule.forRoot>) {
  @Module({ imports: [module], providers: [Mailer] })
  class AppModule {}
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const { i18n } = app.get(Mailer);
  await app.close();
  return i18n.getTranslator("en");
}

describe("I18nModule", () => {
  it("translates from the bundled catalog by default", async () => {
    const t = await translatorFrom(I18nModule.forRoot());
    expect(t("email.otp.expires", { minutes: 5 })).toBe("This code expires in 5 minutes.");
  });

  it("translates from the source it's given", async () => {
    const loaded: string[] = [];
    const t = await translatorFrom(
      I18nModule.forRoot({
        source: {
          load: (locale) => {
            loaded.push(locale);
            return bundledMessages.load(locale);
          },
        },
      }),
    );
    expect(t("email.otp.expires", { minutes: 1 })).toBe("This code expires in 1 minute.");
    expect(loaded).toEqual(["en"]);
  });
});
