"use client";

import { useState } from "react";
import type { EditorChoices } from "../lib/editor-actions";
import { type History, historyOf, push, redo, undo } from "../lib/history";

/** What the member decides in the editor, all of it undoable (lib/editor-actions.ts). */
export type EditChoices = EditorChoices;

export function useEditHistory(initial: EditChoices) {
  const [history, setHistory] = useState<History<EditChoices>>(() => historyOf(initial));
  return {
    choices: history.now,
    change: (next: Partial<EditChoices>) => setHistory((now) => push(now, { ...now.now, ...next })),
    undo: () => setHistory(undo),
    redo: () => setHistory(redo),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
