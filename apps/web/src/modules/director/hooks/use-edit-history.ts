"use client";

import { useState } from "react";
import type { CaptionStyle } from "../lib/captions";
import { type History, historyOf, push, redo, undo } from "../lib/history";

/** What the member decides in the editor, all of it undoable. */
export interface EditChoices {
  style: CaptionStyle;
  /** Caption text the member rewrote, by line key (lib/edit.ts editLines). */
  texts: Record<string, string>;
  /** Whether the takes' own sound goes into the short. */
  sound: boolean;
}

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
