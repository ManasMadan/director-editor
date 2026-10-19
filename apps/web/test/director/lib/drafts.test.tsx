/**
 * Drafts kept in this tab's session storage: read back as kept, and nothing breaks when
 * what's there doesn't read, or when the browser won't let the page use its storage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { dropDraft, keepDraft, readDraft } from "@/modules/director/lib/drafts";

const KEY = "director.test-draft";
const schema = z.object({ text: z.string() });

/** The browser refusing the page its session storage (blocked for the site, say). */
const storageRefused = () =>
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
    throw new DOMException("The page may not use storage.", "SecurityError");
  });

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("a draft kept in the tab", () => {
  it("reads back what was kept, and nothing once it's dropped", () => {
    expect(readDraft(KEY, schema)).toBeNull();
    keepDraft(KEY, { text: "My morning coffee" });
    expect(readDraft(KEY, schema)).toEqual({ text: "My morning coffee" });
    dropDraft(KEY);
    expect(readDraft(KEY, schema)).toBeNull();
  });

  it("starts afresh from a draft of another shape, or one that isn't JSON", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ text: 42 }));
    expect(readDraft(KEY, schema)).toBeNull();
    sessionStorage.setItem(KEY, "{not json");
    expect(readDraft(KEY, schema)).toBeNull();
  });

  it("keeps nothing, and fails nothing, when the browser refuses its storage", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ text: "kept before" }));
    storageRefused();
    expect(readDraft(KEY, schema)).toBeNull();
    expect(() => keepDraft(KEY, { text: "My morning coffee" })).not.toThrow();
    expect(() => dropDraft(KEY)).not.toThrow();
    vi.restoreAllMocks();
    // Neither the draft nor the drop reached the storage.
    expect(readDraft(KEY, schema)).toEqual({ text: "kept before" });
  });
});
