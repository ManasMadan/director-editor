"use client";

import { useSubmitTakeMutation } from "@repo/client/api/director/submit-take";
import type { Shot } from "@repo/contracts/api";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { AudioMode } from "../lib/audio";
import { captureFrame } from "../lib/media";
import { useCountdown } from "./use-countdown";
import { useTakeRecorder } from "./use-take-recorder";

export type Phase = "setup" | "countdown" | "recording" | "preview" | "sending";

/** A take runs a moment past the shot's length, so its best part has room either side. */
const OVERRUN_SECONDS = 1.5;
const PHOTO_WIDTH = 1440;
const PHOTO_QUALITY = 0.92;
const EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "image/jpeg": "jpg",
};

export interface StudioShot {
  videoId: string;
  shot: Shot;
  index: number;
  count: number;
  audio: AudioMode;
  /** A retake asked for from the editor: it goes back there once it's kept. */
  retake?: boolean;
}

/** A shot's page on the shoot screen; `retake` marks one opened from the editor (`&back=edit`). */
export const shotPage = (videoId: string, index: number, audio: AudioMode, retake = false) =>
  `/director/${videoId}/shoot?shot=${index}&audio=${audio}${retake ? "&back=edit" : ""}` as const;

/**
 * Where to go once a take is kept: back to the editor for a retake asked for there; else
 * the next shot, or, once all are in, the editor with Director's cut of them, opened as
 * a wrap.
 */
export function nextPage({ videoId, index, count, audio, retake }: Omit<StudioShot, "shot">) {
  if (retake) {
    return `/director/${videoId}/edit?audio=${audio}` as const;
  }
  return index + 1 < count
    ? shotPage(videoId, index + 1, audio)
    : (`/director/${videoId}/edit?audio=${audio}&wrap=1` as const);
}

/** What the take tells the rest of the screen as it goes. */
export interface TakeEvents {
  /** The 3-2-1 started. */
  onCountdown: () => void;
  /** The 3-2-1 was called off: no take. */
  onCancelled: () => void;
  /** A take started recording (or the photo was taken). */
  onRecording: () => void;
  /** The take is done and on screen to watch back. */
  onRecorded: () => void;
  /** The member threw the take away to go again. */
  onDiscarded: () => void;
  /** The take was kept and sent: on to wherever comes next. */
  onKept: () => void;
}

interface Camera {
  video: RefObject<HTMLVideoElement | null>;
  stream: MediaStream | null;
}

/**
 * Taking the shot once the countdown ends: the photo, or the start of the recording. When
 * it can't (no camera, a browser that can't record), it goes back to setup and says so,
 * rather than leaving the screen on a recording that never started.
 */
function useCapture(shot: Shot, camera: Camera, events: TakeEvents) {
  const recorder = useTakeRecorder(camera.stream);
  const [phase, setPhase] = useState<Phase>("setup");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(events);
  useEffect(() => {
    latest.current = events;
  });
  const capture = useCallback(async () => {
    try {
      const element = camera.video.current;
      if (shot.kind === "photo" && element) {
        setPhoto(await captureFrame(element, PHOTO_WIDTH, PHOTO_QUALITY));
        setPhase("preview");
        latest.current.onRecorded();
      } else if (shot.kind === "video" && recorder.start()) {
        setPhase("recording");
        latest.current.onRecording();
      } else {
        throw new Error("nothing to take the shot with");
      }
    } catch {
      setFailed(true);
      setPhase("setup");
    }
  }, [shot, camera.video, recorder]);
  const countdown = useCountdown(() => void capture());
  return { recorder, phase, setPhase, photo, setPhoto, failed, setFailed, countdown, latest };
}

/** Calls off the countdown: from the shutter, or Escape while it counts. */
function useEscapeCancels(
  counting: boolean,
  cancel: () => void,
  setPhase: (phase: Phase) => void,
  latest: RefObject<TakeEvents>,
) {
  const stopCounting = useCallback(() => {
    cancel();
    setPhase("setup");
    latest.current.onCancelled();
  }, [cancel, setPhase, latest]);
  useEffect(() => {
    if (!counting) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        stopCounting();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [counting, stopCounting]);
  return stopCounting;
}

/**
 * The shutter, the one way a take starts: a tap in setup counts down 3, 2, 1 (a second
 * tap, or Escape, cancels it), then records until it's tapped again or a moment past the
 * shot's length; the take is then watched back, kept and sent, or thrown away to go again.
 */
export function useStudio(studio: StudioShot, camera: Camera, events: TakeEvents) {
  const { shot } = studio;
  const submit = useSubmitTakeMutation();
  const { recorder, phase, setPhase, photo, setPhoto, failed, setFailed, countdown, latest } =
    useCapture(shot, camera, events);

  useEffect(() => {
    if (phase === "recording" && recorder.seconds >= shot.durationSeconds + OVERRUN_SECONDS) {
      recorder.stop();
    }
  }, [phase, shot, recorder]);
  useEffect(() => {
    if (recorder.take) {
      setPhase("preview");
      latest.current.onRecorded();
    }
  }, [recorder.take, setPhase, latest]);
  const counting = phase === "countdown";
  const stopCounting = useEscapeCancels(counting, countdown.cancel, setPhase, latest);

  const take = shot.kind === "photo" ? photo : recorder.take;
  const startOver = () => {
    recorder.discard();
    setPhoto(null);
    submit.reset();
    setPhase("setup");
  };
  const shutter = () => {
    if (phase === "setup") {
      setFailed(false);
      setPhase("countdown");
      countdown.start();
      latest.current.onCountdown();
    } else if (counting) {
      stopCounting();
    } else if (phase === "recording") {
      recorder.stop();
    }
  };
  const use = () => {
    if (!take) {
      return;
    }
    setPhase("sending");
    const file = new File([take], `shot-${studio.index + 1}.${EXTENSIONS[take.type] ?? "webm"}`, {
      type: take.type,
    });
    submit.mutate(
      { videoId: studio.videoId, shotIndex: studio.index, kind: shot.kind, file },
      {
        onSuccess: () => {
          startOver();
          latest.current.onKept();
        },
        onError: () => setPhase("preview"),
      },
    );
  };
  const again = () => {
    startOver();
    latest.current.onDiscarded();
  };
  /** Holds the take where it is: the count called off, or the recording stopped to keep. */
  const halt = () => {
    if (counting) {
      stopCounting();
    } else if (phase === "recording") {
      recorder.stop();
    }
  };
  return {
    phase,
    take,
    failed,
    countdown: countdown.left,
    seconds: phase === "recording" ? recorder.seconds : 0,
    submit,
    actions: { shutter, again, use, halt },
  };
}
