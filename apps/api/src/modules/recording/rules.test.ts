import { describe, expect, it } from "vitest";
import { endOf, expiresAt, readyAttempts, toAttempt, toPart, toSession } from "./rules";

const SESSION = "0199f3a0-0000-7000-8000-000000000001";
const ATTEMPT = "0199f3a0-0000-7000-8000-000000000002";
const TAKE = "0199f3a0-0000-7000-8000-000000000003";
const FILE = "0199f3a0-0000-7000-8000-000000000004";

describe("when footage is deleted", () => {
  const now = new Date("2026-10-18T12:00:00Z");

  it("is a week on, or a day for the demo account", () => {
    expect(expiresAt(now, false)).toEqual(new Date("2026-10-25T12:00:00Z"));
    expect(expiresAt(now, true)).toEqual(new Date("2026-10-19T12:00:00Z"));
  });
});

describe("where an attempt ends", () => {
  const attempt = { partIndex: 1, startMs: 4_000 };

  it("is where it's ended, in its own part", () => {
    expect(endOf(attempt, { partIndex: 1, atMs: 9_000 })).toBe(9_000);
  });

  it("is its part's end once the recorder moved on to another part", () => {
    expect(endOf(attempt, { partIndex: 2, atMs: 1_000 })).toBeNull();
  });

  it("is never before it started", () => {
    expect(endOf(attempt, { partIndex: 1, atMs: 3_000 })).toBe(4_000);
  });
});

describe("the attempts ready for the clipper", () => {
  const stored = (index: number) => ({
    index,
    startMs: index * 10_000,
    durationMs: 10_000,
    status: "uploaded",
  });
  const parts = [
    {
      index: 0,
      sliceCount: null,
      slices: [stored(0), stored(1), { ...stored(2), status: "pending" }],
    },
    { index: 1, sliceCount: 0, slices: [] },
    { index: 2, sliceCount: 2, slices: [stored(0), stored(1)] },
  ];

  it("are those all of whose footage is stored", () => {
    const attempts = [
      { id: "covered", partIndex: 0, endMs: 15_000 },
      { id: "uploading", partIndex: 0, endMs: 25_000 },
      { id: "empty part", partIndex: 1, endMs: null },
      { id: "to the end", partIndex: 2, endMs: null },
      { id: "no such part", partIndex: 3, endMs: 1_000 },
    ];
    expect(readyAttempts(attempts, parts).map((attempt) => attempt.id)).toEqual([
      "covered",
      "empty part",
      "to the end",
    ]);
  });
});

describe("rows as the contract serves them", () => {
  const created = new Date(0);

  it("says a session is paused while it has an open pause", () => {
    const row = {
      id: SESSION,
      videoId: "dQw4w9WgXcQ",
      planId: SESSION,
      status: "recording",
      demo: false,
      recordedMs: 10_000,
      bytes: 2_000_000,
      createdAt: created,
      finishedAt: null,
      expiresAt: created,
    };
    expect(toSession({ ...row, pauses: [] }).paused).toBe(false);
    expect(toSession({ ...row, pauses: [{ partIndex: 0, startMs: 1 }] })).toMatchObject({
      id: SESSION,
      paused: true,
    });
  });

  it("lists a part's stored slices", () => {
    const part = toPart({
      index: 0,
      camera: "front",
      contentType: "video/webm",
      sliceCount: null,
      slices: [
        { index: 0, startMs: 0, durationMs: 10_000, status: "uploaded" },
        { index: 1, startMs: 10_000, durationMs: 10_000, status: "pending" },
      ],
    });
    expect(part.uploaded).toEqual([0]);
  });

  it("gives an attempt its clip once it has one", () => {
    const row = {
      id: ATTEMPT,
      number: 1,
      shotIndex: 0,
      partIndex: 0,
      line: null,
      note: null,
      startMs: 1_000,
      endMs: 5_000,
      status: "waiting",
      clipStartMs: null,
      clipEndMs: null,
      takeId: null,
      fileId: null,
      error: null,
      createdAt: created,
    };
    expect(toAttempt(row).clip).toBeNull();
    expect(
      toAttempt({
        ...row,
        status: "clipped",
        clipStartMs: 750,
        clipEndMs: 5_250,
        takeId: TAKE,
        fileId: FILE,
      }).clip,
    ).toEqual({ startMs: 750, endMs: 5_250 });
  });
});
