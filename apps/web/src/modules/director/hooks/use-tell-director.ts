"use client";

import { useAskEditorMutation } from "@repo/client/api/editor/ask";
import type { EditorReply, EditorState } from "@repo/contracts/api";
import type { VideoId } from "@repo/contracts/ids";
import { useRef } from "react";

/** A request said rather than typed: the recording, base64, and its type. */
export interface Spoken {
  audio: string;
  audioType: "audio/webm" | "audio/mp4" | "audio/ogg";
}

/**
 * Asking Director in the editor. A request sent while another is on its way replaces it:
 * the older answer is dropped when it lands, and only the latest reaches `onReply`.
 */
export function useTellDirector(videoId: VideoId, onReply: (reply: EditorReply) => void) {
  const ask = useAskEditorMutation();
  const latest = useRef(0);
  const send = async (request: { text: string } | Spoken, state: EditorState) => {
    const id = ++latest.current;
    const said =
      "text" in request
        ? { text: request.text, audio: null, audioType: null }
        : {
            text: null,
            ...request,
          };
    const answer = await ask.mutateAsync({ videoId, state, ...said }).catch(() => null);
    if (answer && id === latest.current) {
      onReply(answer);
    }
  };
  return {
    pending: ask.isPending,
    error: ask.isError ? ask.error : null,
    send,
    dismiss: () => {
      ask.reset();
    },
  };
}
