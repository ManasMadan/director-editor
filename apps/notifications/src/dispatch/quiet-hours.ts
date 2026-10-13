/**
 * Quiet hours: a window in the user's time zone (it may cross midnight, e.g. 22:00 to
 * 07:00) when push waits. SMS carries only security texts, which never wait. Returns how
 * long to wait, or 0 outside the window.
 */
import { wallClock } from "../wall-clock";

export function quietDelayMs(
  window: { start: number; end: number } | null,
  timeZone: string,
  now = new Date(),
): number {
  if (!window || window.start === window.end) {
    return 0;
  }
  const clock = wallClock(timeZone, now);
  const minute = clock.hour * 60 + clock.minute;
  const crossesMidnight = window.start > window.end;
  const inside = crossesMidnight
    ? minute >= window.start || minute < window.end
    : minute >= window.start && minute < window.end;
  if (!inside) {
    return 0;
  }
  const minutesLeft = (window.end - minute + 1440) % 1440;
  return (minutesLeft * 60 - clock.second) * 1000;
}
