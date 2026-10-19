"use client";

import type { EditorReply } from "@repo/contracts/api";
import { videoIdSchema } from "@repo/contracts/ids";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import type { AudioMode } from "../lib/audio";
import type { Clip } from "../lib/edit";
import { applyActions, type EditorEffect } from "../lib/editor-actions";
import type { useEditHistory } from "./use-edit-history";
import { shotPage } from "./use-studio";
import { useTellDirector } from "./use-tell-director";

/** The parts of the editor an answer from Director changes. */
export interface TalkingEditor {
  history: Pick<ReturnType<typeof useEditHistory>, "now" | "change" | "undo" | "redo">;
  byShot: readonly Clip[];
  setReply: (reply: EditorReply | null) => void;
  showShot: (shotIndex: number) => void;
}

function repeat(steps: number, once: () => void) {
  for (let step = 0; step < steps; step++) {
    once();
  }
}

/**
 * The "tell Director" bar's requests: each answer that changes something is one step in
 * the edit history (one Undo), the shots it changed are outlined, and what only the page
 * can do (undo, redo, reshooting a shot) is done here.
 *
 * An answer lands seconds after its request: it applies to the choices as they are when
 * it lands, so a take the member picked meanwhile isn't undone by it.
 */
export function useEditorTalk(videoId: string, audio: AudioMode, editor: TalkingEditor) {
  const router = useRouter();
  const latest = useRef(editor);
  useLayoutEffect(() => {
    latest.current = editor;
  });
  const run = (effect: EditorEffect) => {
    switch (effect.kind) {
      case "undo":
        repeat(effect.steps, latest.current.history.undo);
        return;
      case "redo":
        repeat(effect.steps, latest.current.history.redo);
        return;
      case "reshoot":
        router.push(shotPage(videoId, effect.shotIndex, audio, true));
        return;
      default:
        // The asset picker and the soundtrack join here: Director has already said what
        // it would make; until they're in the editor, nothing more happens.
        return;
    }
  };
  return useTellDirector(videoIdSchema.parse(videoId), (reply) => {
    const { history, byShot, setReply, showShot } = latest.current;
    setReply(reply);
    if (reply.outcome !== "applied") {
      return;
    }
    const now = history.now();
    const step = applyActions(now, reply.actions, byShot);
    if (step.choices !== now) {
      history.change(step.choices);
    }
    for (const effect of step.effects) {
      run(effect);
    }
    const first = step.shots[0];
    if (first !== undefined) {
      showShot(first);
    }
  });
}
