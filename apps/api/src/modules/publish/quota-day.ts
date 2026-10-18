/**
 * YouTube's quota day: the YouTube Data API resets a project's daily quota at midnight
 * Pacific time, so Director's daily cap on uploads counts the same day. Worked out with
 * Intl (the runtime's time zone data), so daylight saving moves midnight between 07:00
 * and 08:00 UTC by itself.
 */
import { required } from "@repo/contracts/objects";
import { SECOND_MS } from "@repo/contracts/time";

const ZONE = "America/Los_Angeles";

const dateIn = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const offsetIn = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "longOffset" });

/** Pacific time's offset from UTC at `instant`, in minutes (-420 or -480). */
function offsetAt(instant: Date) {
  const { value } = required(
    offsetIn.formatToParts(instant).find((part) => part.type === "timeZoneName"),
    "the time zone's name",
  );
  // "GMT-07:00" or "GMT-08:00".
  const [, sign, hours, minutes] = required(
    /^GMT([+-])(\d{2}):(\d{2})$/.exec(value),
    "Pacific time's offset",
  );
  return Number(`${sign}1`) * (Number(hours) * 60 + Number(minutes));
}

/** The quota day `now` falls in: its date in Pacific time, as YYYY-MM-DD. */
export const quotaDay = (now: Date) => dateIn.format(now);

/** When the next quota day starts: the next midnight in Pacific time, in epoch seconds. */
export function nextQuotaDay(now: Date) {
  const [year, month, day] = quotaDay(now).split("-").map(Number);
  // Midnight of the next date, first as if it were UTC, then moved by Pacific time's
  // offset at that midnight (daylight saving never changes at midnight there).
  const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day) + 1);
  const guess = asUtc - offsetAt(new Date(asUtc)) * 60 * SECOND_MS;
  return (asUtc - offsetAt(new Date(guess)) * 60 * SECOND_MS) / SECOND_MS;
}
