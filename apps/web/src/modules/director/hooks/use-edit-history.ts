"use client";

import { useState } from "react";
import type { CaptionStyle } from "../lib/captions";
import { type History, historyOf, push, redo, undo } from "../lib/history";
import type { Picks } from "../lib/picks";

/** What the member decides in the editor, all of it undoable. */
export interface EditChoices {
  style: CaptionStyle;
  /** Whether the takes' own sound goes into the video. */
  sound: boolean;
  /** The takes the member picked over Director's, by shot (lib/picks.ts). */
  picks: Picks;
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
