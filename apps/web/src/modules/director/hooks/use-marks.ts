"use client";

import { useLocateMutation } from "@repo/client/api/director/locate";
import type { FrameBox } from "@repo/contracts/api";
import type { Facing, LiveToolResult } from "@repo/contracts/live";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  globalShift,
  luminance,
  type Mark,
  MarkBoard,
  minus,
  moved,
  NO_SHIFT,
  plus,
  SAMPLE_HEIGHT,
  SAMPLE_WIDTH,
  type Shift,
} from "../lib/marks";
import { base64Of, captureFrame } from "../lib/media";
import { viewCrop } from "../lib/view";

/** Four motion samples a second: enough to follow a slow pan between locates. */
const SAMPLE_EVERY_MS = 250;
/** The frame Gemini looks for the thing in: sharper than Live's, still small. */
const LOCATE_WIDTH = 640;
const LOCATE_QUALITY = 0.7;

type Video = RefObject<HTMLVideoElement | null>;

function hasPicture(video: HTMLVideoElement | null): video is HTMLVideoElement {
  return video !== null && video.videoWidth > 0;
}

/** A small greyscale sample of what the viewfinder shows now, for the motion estimate. */
function sampleOf(video: HTMLVideoElement, canvas: HTMLCanvasElement): Uint8Array | null {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  const crop = viewCrop(video.videoWidth, video.videoHeight);
  context.drawImage(
    video,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    SAMPLE_WIDTH,
    SAMPLE_HEIGHT,
  );
  return luminance(context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data);
}

/**
 * Finds a thing in the current frame with `director.locate`: where it is now, the box
 * moved by the camera's motion (`total`) since the frame Gemini looked at, or null.
 */
function useFinder(video: Video, total: RefObject<Shift>) {
  const { mutateAsync } = useLocateMutation();
  return useCallback(
    async (target: string): Promise<FrameBox | null> => {
      const camera = video.current;
      if (!hasPicture(camera)) {
        return null;
      }
      const at = total.current;
      const image = await base64Of(await captureFrame(camera, LOCATE_WIDTH, LOCATE_QUALITY));
      const found = await mutateAsync({ target, image });
      return found.found && found.box ? moved(found.box, minus(total.current, at)) : null;
    },
    [video, total, mutateAsync],
  );
}

/**
 * While `following`, samples the picture four times a second: the camera's motion is
 * added to `total` and moves the board's marks, and `onTick` runs after each sample (the
 * board's lifetimes and re-locates).
 */
function useMotion(
  following: boolean,
  video: Video,
  {
    board,
    total,
    onTick,
  }: { board: RefObject<MarkBoard>; total: RefObject<Shift>; onTick: () => void },
) {
  useEffect(() => {
    if (!following) {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    let previous: Uint8Array | null = null;
    const timer = window.setInterval(() => {
      const camera = video.current;
      const next = hasPicture(camera) ? sampleOf(camera, canvas) : null;
      if (previous && next) {
        const shift = globalShift(previous, next);
        total.current = plus(total.current, shift);
        board.current.move(shift);
      }
      previous = next;
      onTick();
    }, SAMPLE_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [following, video, board, total, onTick]);
}

/**
 * Director's marks on the picture (lib/marks.ts has the rules): `point` finds what
 * Director named in the current frame and pins a mark there, and answers what came of it
 * for Director. While marks show (or a locate is out), the camera's motion moves them;
 * they're located again on the board's cadence and fade when they go.
 */
function useMarks(video: Video) {
  const board = useRef(new MarkBoard());
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  // Locates in flight: the camera's motion is followed from the frame each looked at.
  const [looking, setLooking] = useState(0);
  // Every shift since the shoot started, so a locate's answer is moved by the motion since
  // the frame it looked at.
  const total = useRef<Shift>(NO_SHIFT);
  // Bumped whenever the marks are cleared, so a locate asked before doesn't land after.
  const epoch = useRef(0);
  const sync = useCallback(() => setMarks(board.current.list()), []);
  const find = useFinder(video, total);

  const point = useCallback(
    async (id: string, target: string, label: string): Promise<LiveToolResult> => {
      if (!hasPicture(video.current)) {
        return "no_camera";
      }
      const asked = epoch.current;
      setLooking((now) => now + 1);
      // A locate that fails (Gemini out of reach, the allowance spent) draws nothing,
      // like one that finds nothing: Director says it can't see it rather than guess.
      const box = await find(target)
        .catch(() => null)
        .finally(() => setLooking((now) => now - 1));
      // Cleared while Gemini looked (a take started, the camera flipped, another shot):
      // this mark would point at a picture that's gone.
      if (asked !== epoch.current) {
        return "busy";
      }
      if (!box) {
        return "not_found";
      }
      board.current.add({ id, target, label, box }, performance.now());
      sync();
      return "done";
    },
    [video, find, sync],
  );

  const onTick = useCallback(() => {
    const now = performance.now();
    board.current.tick(now);
    const due = board.current.due(now);
    if (due) {
      void find(due.target)
        .catch(() => null)
        .then((box) => {
          board.current.relocated(due.id, box, performance.now());
          sync();
        });
    }
    sync();
  }, [find, sync]);
  useMotion(marks.length > 0 || looking > 0, video, { board, total, onTick });

  const clear = useCallback(
    (next: "shot" | "picture") => {
      epoch.current += 1;
      if (next === "shot") {
        board.current.newShot();
      } else {
        board.current.clear();
      }
      sync();
    },
    [sync],
  );
  return { marks, point, clear };
}

export type Marks = ReturnType<typeof useMarks>;

/** Runs `effect` each time `value` changes after the first render. */
function useOnChange<T>(value: T, effect: () => void) {
  const last = useRef(value);
  useEffect(() => {
    if (last.current !== value) {
      last.current = value;
      effect();
    }
  });
}

/**
 * The shoot screen's marks: gone on a new shot (which gets its own allowance of
 * re-locates), when the camera flips (the picture they were on is gone) and when a take
 * starts (nothing but the line shows during a take).
 */
export function useShotMarks({
  video,
  facing,
  shot,
  setup,
}: {
  video: Video;
  facing: Facing;
  shot: number;
  /** Setting up, not in a take: marks may show. */
  setup: boolean;
}) {
  const marks = useMarks(video);
  const { clear } = marks;
  useOnChange(shot, () => clear("shot"));
  useOnChange(facing, () => clear("picture"));
  useOnChange(setup, () => clear("picture"));
  return marks;
}
