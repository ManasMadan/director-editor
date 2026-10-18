"use client";

import { useAddRecordingPartMutation } from "@repo/client/api/recording/add-part";
import { useFinishRecordingMutation } from "@repo/client/api/recording/finish";
import { useMarkAttemptMutation } from "@repo/client/api/recording/mark";
import { usePauseRecordingMutation } from "@repo/client/api/recording/pause";
import { useResumeRecordingMutation } from "@repo/client/api/recording/resume";
import { useStartRecordingMutation } from "@repo/client/api/recording/start";
import { useSliceUploader } from "@repo/client/api/recording/upload-slices";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { recorderFormat, VIDEO_BITS_PER_SECOND } from "../lib/media";
import { type PartRecorder, Roll, type RollApi, type RollOptions } from "../lib/roll";

/** How often the indicator's time moves on while the roll records. */
const TICK_MS = 500;

/** The browser's recorder for a part, or null when it can't record this stream. */
const mediaRecorder: RollOptions["record"] = (stream, events) => {
  const format = typeof MediaRecorder === "undefined" ? null : recorderFormat();
  if (!format) {
    return null;
  }
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
  } catch {
    return null;
  }
  recorder.ondataavailable = (event) => events.onData(event.data);
  recorder.onstop = () => events.onStop();
  const part: PartRecorder = {
    state: () => recorder.state,
    start: (timesliceMs) => recorder.start(timesliceMs),
    requestData: () => recorder.requestData(),
    pause: () => recorder.pause(),
    resume: () => recorder.resume(),
    stop: () => recorder.stop(),
  };
  return part;
};

/** The type a recording uploads as, in this browser (WebM, or MP4 in Safari). */
function contentType() {
  const format = typeof MediaRecorder === "undefined" ? null : recorderFormat();
  return format?.uploadType ?? "video/webm";
}

/** The client's recording mutations, as the roll calls them. */
function useRollApi(): RollApi {
  const start = useStartRecordingMutation();
  const addPart = useAddRecordingPartMutation();
  const pause = usePauseRecordingMutation();
  const resume = useResumeRecordingMutation();
  const mark = useMarkAttemptMutation();
  const finish = useFinishRecordingMutation();
  return {
    start: start.mutateAsync,
    addPart: addPart.mutateAsync,
    pause: pause.mutateAsync,
    resume: resume.mutateAsync,
    mark: mark.mutateAsync,
    finish: finish.mutateAsync,
  };
}

/**
 * The shoot screen's roll (lib/roll.ts): one recording from Start shooting to Done, its
 * slices queued for the uploader, which also sends what an earlier visit left behind.
 */
export function useRoll() {
  const uploader = useSliceUploader();
  const api = useRollApi();
  const latest = useRef({ api, enqueue: uploader.enqueue });
  useLayoutEffect(() => {
    latest.current = { api, enqueue: uploader.enqueue };
  });
  const [, changed] = useReducer((count: number) => count + 1, 0);
  const [roll] = useState(
    () =>
      new Roll({
        api: {
          start: (input) => latest.current.api.start(input),
          addPart: (input) => latest.current.api.addPart(input),
          pause: (input) => latest.current.api.pause(input),
          resume: (input) => latest.current.api.resume(input),
          mark: (input) => latest.current.api.mark(input),
          finish: (input) => latest.current.api.finish(input),
        },
        enqueue: (item) => latest.current.enqueue(item),
        record: mediaRecorder,
        contentType: contentType(),
        now: () => performance.now(),
        onChange: changed,
      }),
  );
  const phase = roll.phase;
  useEffect(() => {
    if (phase !== "recording") {
      return;
    }
    const timer = window.setInterval(changed, TICK_MS);
    return () => window.clearInterval(timer);
  }, [phase]);
  useEffect(() => () => roll.leave(), [roll]);
  // The page going away (a closed tab, iOS killing it in the background): what's
  // recorded since the last slice is handed to the queue while it still can be.
  useEffect(() => {
    const going = () => roll.flush();
    window.addEventListener("pagehide", going);
    return () => window.removeEventListener("pagehide", going);
  }, [roll]);
  return {
    roll,
    phase,
    elapsedMs: roll.elapsedMs(),
    /** Footage still to upload, and the last failure (shown, and tried again). */
    upload: {
      pending: uploader.pending,
      behindMs: uploader.behindMs,
      error: uploader.error,
      /** The queue holds five minutes already: the screen pauses until it catches up. */
      full: uploader.full,
    },
  };
}
