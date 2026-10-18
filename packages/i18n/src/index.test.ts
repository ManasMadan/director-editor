import { type MessageFormatElement, parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json" with { type: "json" };
import {
  bundledMessages,
  createI18n,
  localeOrDefault,
  type MessageSource,
  negotiateLocale,
  timeZoneOrUtc,
} from "./index";
import { loosely } from "./loosely";

describe("negotiateLocale", () => {
  it("picks exact, then base-language matches, then the default", () => {
    expect(negotiateLocale("fr-FR,en;q=0.8")).toBe("en");
    expect(negotiateLocale(["fr-FR", "en-GB"])).toBe("en");
    expect(negotiateLocale("de")).toBe("en");
    expect(negotiateLocale(["en"])).toBe("en");
    expect(negotiateLocale(undefined)).toBe("en");
  });
});

describe("localeOrDefault", () => {
  it("keeps a supported locale and falls back to the default for anything else", () => {
    expect(localeOrDefault("en")).toBe("en");
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
  it("formats ICU plurals", async () => {
    const t = await createI18n(bundledMessages).getTranslator("en");
    expect(t("email.otp.expires", { minutes: 1 })).toBe("This code expires in 1 minute.");
    expect(t("email.otp.expires", { minutes: 5 })).toBe("This code expires in 5 minutes.");
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

    i18n.invalidate();
    await i18n.getTranslator("en");
    expect(load).toHaveBeenCalledTimes(4);
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
  it("parse in every message", () => {
    for (const [key, message] of flatten(en)) {
      expect(() => argumentsOf(message), key).not.toThrow();
    }
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
    const messages = await bundledMessages.load("en");
    for (const code of Object.keys(ERROR_CODES)) {
      expect(messages.errors, `missing errors.${code}`).toHaveProperty(code);
    }
  });

  it("has a sentence for every auth error code, and none for codes that aren't one", async () => {
    const { AUTH_ERROR_CODES } = await import("@repo/contracts/errors");
    const messages = await bundledMessages.load("en");
    expect(Object.keys(messages.authErrors).sort()).toEqual(
      [...AUTH_ERROR_CODES, "generic"].sort(),
    );
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
    // Loosely: the key is built at run time, and typing it against the whole catalog is
    // deeper than TypeScript goes at the catalog's size.
    const t = loosely(await createI18n(bundledMessages).getTranslator("en"));
    for (const name of eventNames.filter((event) => !unauditedEvents.has(event))) {
      const key = `workspace.audit.events.${name}`;
      expect(t.has(key), `missing ${key}`).toBe(true);
    }
  });
});
