import { type MessageFormatElement, parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json" with { type: "json" };
import es from "../messages/es.json" with { type: "json" };
import {
  bundledMessages,
  createI18n,
  localeOrDefault,
  type MessageSource,
  negotiateLocale,
  timeZoneOrUtc,
} from "./index";

describe("negotiateLocale", () => {
  it("picks exact, then base-language matches, then the default", () => {
    expect(negotiateLocale("es-MX,es;q=0.9,en;q=0.8")).toBe("es");
    expect(negotiateLocale(["fr-FR", "en-GB"])).toBe("en");
    expect(negotiateLocale("de")).toBe("en");
    expect(negotiateLocale(["es"])).toBe("es");
    expect(negotiateLocale(undefined)).toBe("en");
  });
});

describe("localeOrDefault", () => {
  it("keeps a supported locale and falls back to the default for anything else", () => {
    expect(localeOrDefault("es")).toBe("es");
    expect(localeOrDefault("fr")).toBe("en");
    expect(localeOrDefault(null)).toBe("en");
  });
});

describe("timeZoneOrUtc", () => {
  it("keeps a zone the runtime knows and falls back to UTC for anything else", () => {
    expect(timeZoneOrUtc("Europe/Lisbon")).toBe("Europe/Lisbon");
    expect(timeZoneOrUtc("Mars/Olympus")).toBe("UTC");
    expect(timeZoneOrUtc("")).toBe("UTC");
    expect(timeZoneOrUtc(null)).toBe("UTC");
  });
});

describe("createI18n", () => {
  it("formats ICU plurals per locale", async () => {
    const i18n = createI18n(bundledMessages);
    expect((await i18n.getTranslator("en"))("email.otp.expires", { minutes: 1 })).toBe(
      "This code expires in 1 minute.",
    );
    expect((await i18n.getTranslator("es"))("email.otp.expires", { minutes: 5 })).toBe(
      "Este código caduca en 5 minutos.",
    );
  });

  it("caches per locale, retries after a failed load, and can be invalidated", async () => {
    const load = vi.fn<MessageSource["load"]>().mockRejectedValueOnce(new Error("db down"));
    load.mockImplementation(bundledMessages.load);
    const i18n = createI18n({ load });

    await expect(i18n.getTranslator("en")).rejects.toThrow("db down");
    await i18n.getTranslator("en");
    await i18n.getTranslator("en");
    expect(load).toHaveBeenCalledTimes(2);

    i18n.invalidate("en");
    await i18n.getTranslator("en");
    expect(load).toHaveBeenCalledTimes(3);

    await i18n.getTranslator("es");
    i18n.invalidate();
    await i18n.getTranslator("en");
    await i18n.getTranslator("es");
    expect(load).toHaveBeenCalledTimes(6);
  });
});

/** The arguments and tags in parsed ICU elements, nested ones included, as `name:kind`. */
function namesIn(elements: MessageFormatElement[]): string[] {
  return elements.flatMap((element) => {
    if (element.type === TYPE.literal || element.type === TYPE.pound) {
      return [];
    }
    const options =
      "options" in element
        ? Object.values(element.options).flatMap((option) => namesIn(option.value))
        : [];
    const children = element.type === TYPE.tag ? namesIn(element.children) : [];
    return [`${element.value}:${TYPE[element.type]}`, ...options, ...children];
  });
}

/** Every argument and tag a message names, as `name:kind`, from the ICU parser. */
function argumentsOf(message: string): string[] {
  return [...new Set(namesIn(parse(message)))].sort();
}

/** Every message of a catalog by its dotted key. */
const flatten = (catalog: object, prefix = ""): [string, string][] =>
  Object.entries(catalog).flatMap(([key, value]) =>
    typeof value === "string" ? [[`${prefix}${key}`, value]] : flatten(value, `${prefix}${key}.`),
  );

describe("the ICU arguments of translations", () => {
  it("are the ones English names, of the same kinds, in every message", () => {
    const english = new Map(flatten(en));
    const differ = flatten(es).filter(
      ([key, message]) =>
        argumentsOf(message).join() !== argumentsOf(english.get(key) ?? "").join(),
    );
    expect(differ.map(([key]) => key)).toEqual([]);
  });

  it("are read by name and kind, nested and tagged ones included", () => {
    expect(
      argumentsOf("{count, plural, one {# by {name}} other {<b>#</b>}} on {day, date, short}"),
    ).toEqual(["b:tag", "count:plural", "day:date", "name:argument"]);
  });
});

describe("catalog completeness", () => {
  it("has a translated message for every API error code", async () => {
    const { ERROR_CODES } = await import("@repo/contracts/errors");
    for (const locale of ["en", "es"] as const) {
      const messages = await bundledMessages.load(locale);
      for (const code of Object.keys(ERROR_CODES)) {
        expect(messages.errors, `${locale} is missing errors.${code}`).toHaveProperty(code);
      }
    }
  });

  it("has a sentence for every auth error code, and none for codes that aren't one", async () => {
    const { AUTH_ERROR_CODES } = await import("@repo/contracts/errors");
    for (const locale of ["en", "es"] as const) {
      const messages = await bundledMessages.load(locale);
      expect(Object.keys(messages.authErrors).sort(), locale).toEqual(
        [...AUTH_ERROR_CODES, "generic"].sort(),
      );
    }
  });

  it("asks for exactly the params an error code is declared with", async () => {
    const { ERROR_CODES, ERROR_PARAMS } = await import("@repo/contracts/errors");
    const messages = en.errors as Record<string, string>;
    for (const code of Object.keys(ERROR_CODES)) {
      const declared =
        code in ERROR_PARAMS
          ? Object.keys(ERROR_PARAMS[code as keyof typeof ERROR_PARAMS].shape).sort()
          : [];
      const named = argumentsOf(messages[code] ?? "").map((argument) => argument.split(":")[0]);
      expect(named, code).toEqual(declared);
    }
  });

  it("describes every domain event in the audit log", async () => {
    const { eventNames, unauditedEvents } = await import("@repo/contracts/events");
    for (const locale of ["en", "es"] as const) {
      const i18n = createI18n(bundledMessages);
      const t = await i18n.getTranslator(locale);
      for (const name of eventNames.filter((event) => !unauditedEvents.has(event))) {
        const key = `workspace.audit.events.${name}` as Parameters<typeof t>[0];
        expect(t.has(key), `${locale} is missing workspace.audit.events.${name}`).toBe(true);
      }
    }
  });

  it("names every notification category and in-app notification type", async () => {
    const { inAppNotifications, notificationCategories } = await import(
      "@repo/contracts/notifications"
    );
    for (const locale of ["en", "es"] as const) {
      const t = await createI18n(bundledMessages).getTranslator(locale);
      for (const name of Object.keys(notificationCategories)) {
        const key = `notificationSettings.categories.${name}.title` as Parameters<typeof t>[0];
        expect(t.has(key), `${locale} is missing ${key}`).toBe(true);
      }
      for (const type of Object.keys(inAppNotifications)) {
        for (const part of ["title", "body"]) {
          const key = `notification.${type}.${part}` as Parameters<typeof t>[0];
          expect(t.has(key), `${locale} is missing ${key}`).toBe(true);
        }
      }
    }
  });

  it("labels every event customers can subscribe to", async () => {
    const { webhookEvents } = await import("@repo/contracts/events");
    for (const locale of ["en", "es"] as const) {
      const t = await createI18n(bundledMessages).getTranslator(locale);
      for (const name of webhookEvents) {
        const key = `workspace.webhooks.eventLabels.${name}` as Parameters<typeof t>[0];
        expect(t.has(key), `${locale} is missing workspace.webhooks.eventLabels.${name}`).toBe(
          true,
        );
      }
    }
  });
});
