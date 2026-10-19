/**
 * Work in progress kept in this tab's session storage, so a reload (or a trip to the
 * shoot screen and back) picks up where the member was: the editor's choices, the brief
 * of a template of their own. It stays in this tab and is gone when the tab closes; what
 * must outlive that belongs on the server, behind an API procedure.
 *
 * What's read is parsed: storage is outside the app's control, and a value from an older
 * version or another member must never break the page. Without session storage (blocked,
 * full, a private window that refuses it) nothing is kept, and nothing else changes.
 */
import type * as z from "zod";

/** The draft kept under `key`, or null when there's none or it doesn't read as `schema`. */
export function readDraft<T>(key: string, schema: z.ZodType<T>): T | null {
  try {
    const kept = sessionStorage.getItem(key);
    if (kept === null) {
      return null;
    }
    const parsed = schema.safeParse(JSON.parse(kept));
    return parsed.success ? parsed.data : null;
  } catch {
    // Unreadable (storage refused, or not JSON): start afresh rather than fail.
    return null;
  }
}

export function keepDraft(key: string, draft: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage refused or full: a reload starts afresh, as it did before drafts were kept.
    return;
  }
}

export function dropDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage refused: there was nothing kept to drop.
    return;
  }
}
