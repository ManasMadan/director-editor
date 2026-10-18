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

  // Changes made while a re-plan runs (a chip taken away, a row put back, Director
  // adapting a shot), to make again on top of the re-planned version once it lands.
  const during = useRef<((now: YourVersion) => YourVersion)[] | null>(null);

  /** A change made here (a tool call, a tap): shown at once, then kept. */
  const change = useCallback(
    (step: (now: YourVersion) => YourVersion) => {
      during.current?.push(step);
      const next = settle(step(latest.current.version));
      save({ videoId, version: next });
      return next;
    },
    [settle, save, videoId],
  );

  /**
   * Director re-plans what's left from one instruction; the API keeps the result. The
   * member's own changes made meanwhile are made again on top of it, and kept: the save
   * goes after the re-plan's (they share one queue), so it has the last word.
   */
  const replan = useCallback(
    async (instruction: string) => {
      during.current = [];
      try {
        const result = await revise({ videoId, instruction, version: latest.current.version });
        const steps = during.current;
        const next = steps.reduce((version, step) => step(version), result.version);
        settle(next);
        if (steps.length > 0) {
          save({ videoId, version: next });
        }
        return { ...result, version: next };
      } finally {
        during.current = null;
      }
    },
    [revise, settle, save, videoId],
  );

  /** The version as it is now, with changes not yet rendered (a tool call right after another). */
  const current = useCallback(() => latest.current.version, []);

  return { version, ready: !query.isPending, change, replan, current };
}

export type YourVersionState = ReturnType<typeof useYourVersion>;
