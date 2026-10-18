"use client";

import { useDirectorShotsQuery } from "@repo/client/api/director/shots";
import { useFileDownloadUrl } from "@repo/client/api/files/download-url";
import type { DirectorShot, DirectorTake } from "@repo/contracts/api";
import type { FileId } from "@repo/contracts/ids";
import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { matchCutInto, type PlanLike } from "../lib/match-cuts";

/** The ghost's size: the finished frame's, halved (it's shown faint, over the camera). */
const GHOST_WIDTH = 360;
const GHOST_HEIGHT = 640;
/** How far before the kept part's end the frame is taken: the last frame really shown. */
const BEFORE_END_SECONDS = 0.05;

/** The take the editor would play for a shot: its pick, else its newest filmed video. */
function ghostTake(shot: DirectorShot | undefined): DirectorTake | undefined {
  const videos = (shot?.takes ?? []).filter(
    (take) => take.kind === "video" && take.status === "ready",
  );
  return videos.find((take) => take.id === shot?.pickedTakeId) ?? videos[0];
}

/** The last frame of a take's kept part, fitted to the 9:16 frame, as a JPEG data URL. */
async function lastFrame(source: string, endMs: number | null): Promise<string> {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`storage answered ${response.status}`);
  }
  const url = URL.createObjectURL(await response.blob());
  const video = document.createElement("video");
  try {
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error("the take couldn't be read"));
    });
    const end = endMs === null ? video.duration : endMs / 1000;
    video.currentTime = Math.max(0, end - BEFORE_END_SECONDS);
    await new Promise((resolve) => {
      video.onseeked = resolve;
    });
    const canvas = document.createElement("canvas");
    canvas.width = GHOST_WIDTH;
    canvas.height = GHOST_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("no canvas to draw on");
    }
    const scale = Math.max(GHOST_WIDTH / video.videoWidth, GHOST_HEIGHT / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    ctx.drawImage(video, (GHOST_WIDTH - w) / 2, (GHOST_HEIGHT - h) / 2, w, h);
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The ghost's picture: the frame at `endMs` (the take's end when null) of the take in
 * `fileId`, once it's drawn; none while it loads or if it can't be.
 */
function useLastFrame(fileId: FileId | undefined, endMs: number | null) {
  // A new function each render: held in a ref, so only another take draws again.
  const downloadUrl = useRef(useFileDownloadUrl());
  const [frame, setFrame] = useState<{ key: string; src: string } | null>(null);
  const key = `${fileId}:${endMs}`;
  useEffect(() => {
    if (!fileId) {
      return;
    }
    let current = true;
    downloadUrl
      .current(fileId)
      .then(({ url }) => lastFrame(url, endMs))
      .then(
        (src) => {
          if (current) {
            setFrame({ key: `${fileId}:${endMs}`, src });
          }
        },
        // No ghost is a plain shot: Director still coaches the framing in words.
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [fileId, endMs]);
  return frame && frame.key === key ? frame.src : null;
}

/**
 * The ghost for a match cut (spec 9.5 and 6.1): the last frame of the shot before at 35%
 * opacity over the camera, so the member puts the anchor (the watch) right where it was.
 * Shown only when the plan's cut into this shot is a match cut and the shot before has a
 * filmed take; mirrored like the camera, so it lines up with what the member sees.
 */
export function MatchGhost({
  videoId,
  plan,
  index,
  facing,
}: {
  videoId: string;
  plan: PlanLike;
  index: number;
  facing: "front" | "back";
}) {
  const t = useTranslations("director.matchCut");
  const anchor = matchCutInto(plan, index);
  const shots = useDirectorShotsQuery(videoId, anchor !== null);
  const before = anchor === null ? undefined : ghostTake(shots.data?.[index - 1]);
  const src = useLastFrame(before?.fileId, before?.bestEndMs ?? null);
  if (anchor === null || src === null) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-0">
      {/* A data URL drawn here: Next's image component has nothing to optimise. */}
      <img
        src={src}
        alt={t("ghostLabel")}
        className={cn(
          "absolute inset-0 size-full opacity-35",
          facing === "front" && "-scale-x-100",
        )}
      />
      <p className="absolute inset-x-0 top-1/4 mx-auto w-fit max-w-[80%] rounded-full bg-studio/70 px-3 py-1 text-center text-sm font-semibold">
        {t("ghost", { anchor })}
      </p>
    </div>
  );
}
