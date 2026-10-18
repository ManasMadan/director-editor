"use client";

import { useSubmitTakeMutation } from "@repo/client/api/director/submit-take";
import type { Shot } from "@repo/contracts/api";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { AudioMode } from "../lib/audio";
import { captureFrame } from "../lib/media";
import { useCamera } from "./use-camera";
import { useCountdown } from "./use-countdown";
import { useTakeRecorder } from "./use-take-recorder";

type Phase = "setup" | "countdown" | "recording" | "preview" | "sending";

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
}

/** A shot's camera screen. */
export const shotPage = (videoId: string, index: number, audio: AudioMode) =>
  `/director/${videoId}/shoot?shot=${index}&audio=${audio}` as const;

/**
 * Where to go once a take is kept: the next shot, or, once all are in, the editor with
 * Director's cut of them, opened as a wrap.
 */
export function nextPage({ videoId, index, count, audio }: Omit<StudioShot, "shot">) {
  return index + 1 < count
    ? shotPage(videoId, index + 1, audio)
    : (`/director/${videoId}/edit?audio=${audio}&wrap=1` as const);
}

/**
 * Taking the shot once the countdown ends: the photo, or the start of the recording. When
 * it can't (no camera, a browser that can't record), it goes back to setup and says so,
 * rather than leaving the screen on a recording that never started.
 */
function useCapture(
  shot: Shot,
  camera: ReturnType<typeof useCamera>,
  recorder: ReturnType<typeof useTakeRecorder>,
  countdownFrom: number,
) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [failed, setFailed] = useState(false);
  const capture = useCallback(async () => {
    try {
      const element = camera.video.current;
      if (shot.kind === "photo" && element) {
        setPhoto(await captureFrame(element, PHOTO_WIDTH, PHOTO_QUALITY));
        setPhase("preview");
      } else if (shot.kind === "video" && recorder.start()) {
        setPhase("recording");
      } else {
        throw new Error("nothing to take the shot with");
      }
    } catch {
      setFailed(true);
      setPhase("setup");
    }
  }, [shot, camera.video, recorder]);
  const countdown = useCountdown(() => void capture(), countdownFrom);
  const record = () => {
    if (phase !== "setup") {
      return;
    }
    setFailed(false);
    setPhase("countdown");
    countdown.start();
  };
  return { phase, setPhase, photo, setPhoto, failed, countdown: countdown.left, record };
}

/**
 * One shot's take, start to finish: setup (guides on), a countdown, recording (or the
 * photo), the preview, then sending it to Director and moving on.
 */
export function useStudio(studio: StudioShot, countdownFrom: number) {
  const { shot } = studio;
  const router = useRouter();
  const micOn = studio.audio === "voice" && shot.kind === "video";
  const camera = useCamera(shot.camera, micOn);
  const recorder = useTakeRecorder(camera.stream);
  const submit = useSubmitTakeMutation();
  const { phase, setPhase, photo, setPhoto, failed, countdown, record } = useCapture(
    shot,
    camera,
    recorder,
    countdownFrom,
  );

  useEffect(() => {
    if (phase === "recording" && recorder.seconds >= shot.durationSeconds + OVERRUN_SECONDS) {
      recorder.stop();
    }
  }, [phase, shot, recorder]);
  useEffect(() => {
    if (recorder.take) {
      setPhase("preview");
    }
  }, [recorder.take, setPhase]);

  const take = shot.kind === "photo" ? photo : recorder.take;
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
      { onSuccess: () => router.push(nextPage(studio)), onError: () => setPhase("preview") },
    );
  };
  const retake = () => {
    recorder.discard();
    setPhoto(null);
    submit.reset();
    setPhase("setup");
  };
  const seconds = phase === "recording" ? recorder.seconds : 0;
  return {
    camera,
    micOn,
    phase,
    take,
    failed,
    countdown,
    seconds,
    submit,
    actions: { record, stop: recorder.stop, retake, use },
  };
}
