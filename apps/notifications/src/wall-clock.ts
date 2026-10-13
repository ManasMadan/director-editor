/**
 * What the clock says now in a user's time zone, for quiet hours and the daily digest.
 * An unknown zone (a stored value that isn't one) reads as UTC rather than throwing, so
 * one bad row can't make a delivery or the digest run fail over and over.
 */
import { timeZoneOrUtc } from "@repo/i18n";

export function wallClock(timeZone: string | null | undefined, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZoneOrUtc(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  // Every part asked for above is in the result.
  const part = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    hour: Number(part.hour),
    minute: Number(part.minute),
    second: Number(part.second),
    date: `${part.year}-${part.month}-${part.day}`,
  };
}
