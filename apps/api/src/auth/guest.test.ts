import { describe, expect, it } from "vitest";
import { clampToGuestDay } from "./guest";

const until = new Date("2026-10-19T12:00:00.000Z");
const later = new Date("2026-10-25T12:00:00.000Z");
const sooner = new Date("2026-10-19T08:00:00.000Z");

describe("clampToGuestDay", () => {
  it("never lets a guest's session expire after its day", () => {
    const update = { expiresAt: later, updatedAt: sooner };
    expect(clampToGuestDay(update, { guestUntil: until })).toEqual({
      expiresAt: until,
      updatedAt: sooner,
    });
    // As better-auth's session cache in Valkey hands it over: a string.
    expect(clampToGuestDay(update, { guestUntil: until.toISOString() }).expiresAt).toEqual(until);
  });

  it("leaves an expiry within the day, an update without one, and everyone else alone", () => {
    const within = { expiresAt: sooner };
    expect(clampToGuestDay(within, { guestUntil: until })).toBe(within);
    const elsewhere: { activeOrganizationId: string; expiresAt?: Date } = {
      activeOrganizationId: "o",
    };
    expect(clampToGuestDay(elsewhere, { guestUntil: until })).toBe(elsewhere);
    const member = { expiresAt: later };
    expect(clampToGuestDay(member, { guestUntil: null })).toBe(member);
    expect(clampToGuestDay(member, { id: "u" })).toBe(member);
    expect(clampToGuestDay(member, undefined)).toBe(member);
  });
});
