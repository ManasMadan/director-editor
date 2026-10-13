/**
 * Money is an integer amount in the currency's minor unit (cents for USD, yen for JPY)
 * plus an ISO 4217 code. Never a float: 0.1 + 0.2 !== 0.3.
 */
import * as z from "zod";

const money = z.object({
  amount: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Money = z.infer<typeof money>;

/** Formats for display in the given locale, e.g. formatMoney({ amount: 1999, currency: "USD" }, "en") → "$19.99". */
export function formatMoney({ amount, currency }: Money, locale: string) {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  // The currency's own minor-unit digits: none for JPY, so no fraction part at all.
  const digits =
    format.formatToParts(0).find((part) => part.type === "fraction")?.value.length ?? 0;
  return format.format(amount / 10 ** digits);
}
