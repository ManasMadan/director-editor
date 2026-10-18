"use client";

import { errorCode } from "@repo/client";
import { useSpeakMutation } from "@repo/client/api/director/speak";
import type { DirectorSpeech, DirectorVoice } from "@repo/contracts/api";
import { MINUTE_MS } from "@repo/contracts/time";
import { useCallback, useRef } from "react";
import type { Voice } from "../lib/speech";

/** Gemini's upbeat voice: a coach on set, not a narrator. */
const DIRECTOR_VOICE: DirectorVoice = "Puck";
/** A kept link is asked for again once it has less than this left to live. */
const LINK_MARGIN_MS = MINUTE_MS;
/** How long the browser's voice stands in after Director's fails, before it's tried again. */
const REST_AFTER_FAILURE_MS = MINUTE_MS;

/**
 * Director's own voice for the shoot screen (lib/speech.ts's `Voice`): a link to each line
 * spoken by Gemini, asked for once per line and kept while its link lives. After a
 * failure it rests for a minute, and once the API says the voice is off (no uploads to
 * keep the lines in) it stops for good: otherwise every cue would wait on a request that
 * fails before the browser's voice said it, and cues a moment apart would be lost.
 */
export function useDirectorVoice(): Voice {
  const { mutateAsync } = useSpeakMutation();
  const kept = useRef(new Map<string, DirectorSpeech>());
  const restUntil = useRef(0);
  return useCallback(
    async (text: string) => {
      if (Date.now() < restUntil.current) {
        throw new Error("Director's own voice is resting");
      }
      const known = kept.current.get(text);
      if (known && known.expiresAt.getTime() - Date.now() > LINK_MARGIN_MS) {
        return known.url;
      }
      try {
        const speech = await mutateAsync({ text, voice: DIRECTOR_VOICE });
        kept.current.set(text, speech);
        return speech.url;
      } catch (error) {
        restUntil.current =
          errorCode(error) === "FEATURE_DISABLED"
            ? Number.POSITIVE_INFINITY
            : Date.now() + REST_AFTER_FAILURE_MS;
        throw error;
      }
    },
    [mutateAsync],
  );
}
