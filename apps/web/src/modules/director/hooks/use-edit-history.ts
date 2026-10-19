"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { keepDraft, readDraft } from "../lib/drafts";
import { type EditorChoices, editorChoicesSchema } from "../lib/editor-actions";
import { type History, historyOf, push, redo, undo } from "../lib/history";

/** What the member decides in the editor, all of it undoable (lib/editor-actions.ts). */
export type EditChoices = EditorChoices;

const draftKey = (key: string) => `director.edit.${key}`;

/**
 * The editor's choices with undo and redo. With a `key` (the member and the template),
 * the choices are kept in this tab (lib/drafts.ts): a reload, or a reshoot and back,
 * opens on them instead of Director's picks. Undo starts afresh each visit.
 */
export function useEditHistory(initial: EditChoices, key: string | null = null) {
  const [history, setHistory] = useState<History<EditChoices>>(() =>
    historyOf((key ? readDraft(draftKey(key), editorChoicesSchema) : null) ?? initial),
  );
  useEffect(() => {
    if (key) {
      keepDraft(draftKey(key), history.now);
    }
  }, [key, history.now]);
  // The choices on screen now, for an answer to a request made earlier (Director's).
  const latest = useRef(history.now);
  useLayoutEffect(() => {
    latest.current = history.now;
  });
  return {
    choices: history.now,
    now: () => latest.current,
    change: (next: Partial<EditChoices>) => setHistory((now) => push(now, { ...now.now, ...next })),
    undo: () => setHistory(undo),
    redo: () => setHistory(redo),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
