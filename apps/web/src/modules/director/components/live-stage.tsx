"use client";

import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * The night the camera floats in: the live picture itself, blurred far out of focus and
 * dimmed under a deep blue sky, so the room's colour seeps round the viewport the way a
 * window's light does round a frame.
 */
export function LiveBackdrop({ stream }: { stream: MediaStream | null }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (video.current) {
      video.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <div aria-hidden className="fixed inset-0 overflow-hidden bg-live-deep">
      <video
        ref={video}
        autoPlay
        muted
        playsInline
        className="absolute inset-0 size-full scale-125 object-cover opacity-45 blur-3xl saturate-150"
      />
      <div className="absolute inset-0 bg-[radial-gradient(120%_70%_at_50%_0%,color-mix(in_oklch,var(--live-night)_70%,transparent),var(--live-deep)_78%)]" />
    </div>
  );
}

/**
 * The viewport: the camera in a floating capsule with deep corners, lit from behind by an
 * aurora that breathes while Director talks or listens (`glowing`), and flashes on the
 * beat when a step changes (`beat` changes).
 */
export function LiveViewport({
  glowing,
  recording,
  beat,
  children,
}: {
  glowing: boolean;
  recording: boolean;
  beat: number;
  children: ReactNode;
}) {
  return (
    <div className="live-motion relative mx-auto w-[min(calc(100vw-1.5rem),calc((100dvh-10.5rem)*9/16))]">
      <div
        aria-hidden
        className={cn(
          "absolute -inset-3 rounded-[2.9rem] blur-2xl transition-opacity duration-700",
          glowing ? "opacity-90" : "opacity-35",
          recording && "opacity-0",
        )}
      >
        <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
          <div className="absolute -inset-1/2 animate-[live-drift_14s_linear_infinite] bg-[conic-gradient(from_0deg,var(--aurora-1),var(--aurora-2),var(--aurora-3),var(--aurora-1))]" />
        </div>
      </div>
      <div
        className={cn(
          "relative aspect-9/16 overflow-hidden rounded-[2.25rem] bg-studio shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)] ring-1 transition-[box-shadow] duration-500",
          recording ? "ring-2 ring-record" : "ring-studio-foreground/15",
        )}
      >
        {children}
        {beat > 0 ? (
          <span
            key={beat}
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-[live-beat_600ms_ease-out_forwards] rounded-[inherit] ring-8 ring-doodle-pop ring-inset"
          />
        ) : null}
      </div>
    </div>
  );
}

/** "3, 2, 1": each number lands big in the marker hand, with a ripple, on the beat. */
export function CountdownPulse({ seconds }: { seconds: number | null }) {
  const t = useTranslations("director.live.say");
  if (seconds === null) {
    return null;
  }
  return (
    <div
      aria-live="assertive"
      className="live-motion pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span
        key={`ring-${seconds}`}
        aria-hidden
        className="absolute size-40 animate-[live-ripple_900ms_ease-out_forwards] rounded-full border-4 border-doodle-pop"
      />
      <span
        key={seconds}
        className="animate-[live-count_500ms_cubic-bezier(.2,.9,.3,1.2)_forwards] font-[family-name:var(--font-hand)] text-[10rem] leading-none text-doodle-paper drop-shadow-[0_6px_0_var(--studio)]"
      >
        {t("count", { seconds })}
      </span>
    </div>
  );
}
