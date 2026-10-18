"use client";

import { useReviseMutation } from "@repo/client/api/director/revise";
import { useSaveYourVersionMutation } from "@repo/client/api/director/save-your-version";
import { useYourVersionQuery } from "@repo/client/api/director/your-version";
import { EMPTY_VERSION, type YourVersion } from "@repo/contracts/api";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The member's version of the plan for this screen (lib/your-version.ts): read from the
 * API once, then held here, kept after every change, and re-planned by Director.
 * `onChange` hears each new version as soon as it exists (Director live is briefed with
 * it before a tool call is answered), including the one first read from the API.
 */
export function useYourVersion(videoId: string, onChange: (version: YourVersion) => void) {
  const query = useYourVersionQuery(videoId);
  const { mutate: save } = useSaveYourVersionMutation(videoId);
  const { mutateAsync: revise } = useReviseMutation(videoId);
  const [local, setLocal] = useState<YourVersion | null>(null);
  const version = local ?? query.data ?? EMPTY_VERSION;
  const latest = useRef({ version, onChange });
  useLayoutEffect(() => {
    latest.current = { version, onChange };
  });
  const loaded = query.data;
  useEffect(() => {
    if (loaded) {
      latest.current.onChange(latest.current.version);
    }
  }, [loaded]);

  const settle = useCallback((next: YourVersion) => {
    latest.current.version = next;
    setLocal(next);
    latest.current.onChange(next);
    return next;
  }, []);

  /** A change made here (a tool call, a tap): shown at once, then kept. */
  const change = useCallback(
    (step: (now: YourVersion) => YourVersion) => {
      const next = settle(step(latest.current.version));
      save({ videoId, version: next });
      return next;
    },
    [settle, save, videoId],
  );

  /** Director re-plans what's left from one instruction; the API keeps the result. */
  const replan = useCallback(
    async (instruction: string) => {
      const result = await revise({ videoId, instruction, version: latest.current.version });
      settle(result.version);
      return result;
    },
    [revise, settle, videoId],
  );

  return { version, ready: !query.isPending, change, replan };
}

export type YourVersionState = ReturnType<typeof useYourVersion>;
