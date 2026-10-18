"use client";

import { nearRecordingLimit, useRecordingSessionQuery } from "@repo/client/api/recording/session";
import type { LiveToolCall, LiveToolResult } from "@repo/contracts/live";
import { RECORDING_WARN_MS } from "@repo/contracts/recording";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";
import { wakeLiveAudio } from "../lib/live-audio";
import { type Roll, shotStates } from "../lib/roll";
import type { useCamera } from "./use-camera";
import type { DirectorLive } from "./use-director-live";
import { useRoll } from "./use-roll";
import { nextPage, type StudioShot, shotPage } from "./use-studio";

type MarkCall = Extract<LiveToolCall, { name: "mark" }>;

interface Options {
  props: StudioShot;
  camera: ReturnType<typeof useCamera>;
  live: DirectorLive;
  /** Start shooting was tapped, with Director on: the roll starts once the camera's up. */
  wanted: boolean;
}

/**
 * Locking the phone or switching apps pauses, as the pause button does; so does the
 * upload queue holding five minutes already, until it catches up.
 */
function useAutoPause(pause: () => void, full: boolean) {
  const latest = useRef(pause);
  useLayoutEffect(() => {
    latest.current = pause;
  });
  useEffect(() => {
    if (full) {
      latest.current();
    }
  }, [full]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        latest.current();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
}

interface Latest {
  current: Pick<Options, "props" | "camera" | "live">;
}

/**
 * The roll starts with the camera's first picture, and each new picture after (a flip,
 * the camera reopened) records in a part of its own.
 */
function useRollCamera(roll: Roll, stream: MediaStream | null, wanted: boolean, latest: Latest) {
  const recorded = useRef<MediaStream | null>(null);
  useEffect(() => {
    const now = latest.current;
    if (wanted && stream && roll.phase === "off") {
      recorded.current = stream;
      void roll.start(now.props.videoId, stream, now.camera.facing).then((started) => {
        if (started) {
          latest.current.live.roll("recording");
        }
      });
    } else if (stream && recorded.current && stream !== recorded.current) {
      recorded.current = stream;
      void roll.flip(stream, now.camera.facing);
    }
  }, [wanted, stream, roll, latest]);
}

/**
 * The roll on the shoot screen, wired to the camera and Director: it starts with the
 * camera's first picture, starts a new part on each flip, tells Director where it is
 * (and keeps it from seeing or hearing a pause), pauses when the tab is hidden, and
 * after Done opens the editor once the footage on this device is uploaded.
 */
export function useRollShoot({ props, camera, live, wanted }: Options) {
  const router = useRouter();
  const { roll, phase, elapsedMs, upload } = useRoll();
  const latest = useRef({ props, camera, live });
  useLayoutEffect(() => {
    latest.current = { props, camera, live };
  });
  useRollCamera(roll, camera.stream, wanted, latest);

  // Director (re)joined while the roll goes on: it hears where it is.
  useEffect(() => {
    if (live.state === "live" && (roll.phase === "recording" || roll.phase === "paused")) {
      latest.current.live.roll(roll.phase === "paused" ? "paused" : "recording");
    }
  }, [live.state, roll]);

  const pause = () => {
    if (roll.phase === "recording") {
      roll.pause();
      latest.current.live.roll("paused");
    }
  };
  useAutoPause(pause, upload.full);

  // Where Done leads: the editor, as the last shot's take would.
  const editor = nextPage({ ...props, index: props.count - 1 });
  useEffect(() => {
    if (phase === "done" && upload.pending === 0) {
      router.push(editor);
    }
  }, [phase, upload.pending, router, editor]);

  const session = useRecordingSessionQuery(roll.currentSession());
  return {
    phase,
    editor,
    /**
     * The shoot is past 17 of its 20 minutes: as recorded here, or as the server has
     * counted what's uploaded.
     */
    nearLimit:
      elapsedMs >= RECORDING_WARN_MS ||
      (session.data !== undefined && nearRecordingLimit(session.data)),
    /** The roll is the way this shoot records (not the shutter). */
    rolling:
      phase === "recording" || phase === "paused" || phase === "finishing" || phase === "done",
    elapsedMs,
    upload,
    states: shotStates(props.count, session.data?.attempts ?? []),
    pause,
    resume: () => {
      // The tap that resumes is also what lets iOS run Director's sound again after a lock.
      wakeLiveAudio();
      const now = latest.current.camera;
      if (now.stream && roll.phase === "paused") {
        void roll.resume(now.stream, now.facing).then(() => latest.current.live.roll("resumed"));
      }
    },
    done: () => {
      void roll.done().then(() => latest.current.live.roll("done"));
    },
    /** The member tapped a shot in the progress strip: it opens, and Director moves too. */
    go: (shot: number) => {
      const { props: now } = latest.current;
      router.push(shotPage(now.videoId, shot, now.audio, now.retake));
    },
    /** Director's mark, on the shot on screen; what came of it. */
    mark: (call: MarkCall): Promise<LiveToolResult> =>
      roll.mark(call.event, latest.current.props.index, {
        ...(call.line ? { line: call.line } : {}),
        ...(call.note ? { note: call.note } : {}),
      }),
  };
}

export type RollShoot = ReturnType<typeof useRollShoot>;
