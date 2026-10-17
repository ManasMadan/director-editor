"use client";

import { cn } from "@repo/ui/lib/utils";
import { Mic, MicOff, Pause, Play, ScreenShare, ScreenShareOff, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { ListenState } from "../hooks/use-listening";
import { CallButton } from "./live-call";
import { GLASS } from "./live-hud";

function DockButton({
  label,
  pressed,
  onClick,
  disabled,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex size-12 items-center justify-center rounded-full transition-[background-color,transform,color] duration-200 active:scale-90 disabled:opacity-35",
        pressed
          ? "bg-studio-foreground text-studio"
          : "bg-studio-foreground/10 hover:bg-studio-foreground/20",
      )}
    >
      {children}
    </button>
  );
}

const RING = 2 * Math.PI * 36;

/**
 * The shutter: a white ring round a red dot to record (a white one for a photo), a red
 * square to stop, with the take's progress running round the ring while it records.
 */
export function Shutter({
  mode,
  label,
  progress,
  disabled,
  onClick,
}: {
  mode: "record" | "photo" | "stop";
  label: string;
  progress: number;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="group relative flex size-[76px] shrink-0 items-center justify-center rounded-full transition-transform duration-200 active:scale-90 disabled:opacity-40"
    >
      <svg aria-hidden viewBox="0 0 80 80" className="absolute inset-0 size-full -rotate-90">
        <circle
          cx="40"
          cy="40"
          r="36"
          fill="none"
          strokeWidth="4"
          className="stroke-studio-foreground/85"
        />
        {mode === "stop" ? (
          <circle
            cx="40"
            cy="40"
            r="36"
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - Math.min(1, progress))}
            className="stroke-doodle-pop transition-[stroke-dashoffset] duration-100 ease-linear"
          />
        ) : null}
      </svg>
      <span
        className={cn(
          "transition-all duration-300 ease-[cubic-bezier(.3,1.4,.5,1)]",
          mode === "stop" ? "size-7 rounded-lg bg-record" : "size-[60px] rounded-full",
          mode === "record" && "bg-record group-hover:scale-95",
          mode === "photo" && "bg-studio-foreground group-hover:scale-95",
        )}
      />
    </button>
  );
}

/**
 * The frosted dock under the viewport, Gemini Live's way round: call Director, show it
 * the screen, talk to it, the shutter in the middle, pause Director, end. When the member
 * leaves the screen alone it steps back (`idle`), all but the shutter.
 */
export function LiveDock({
  idle,
  onCall,
  shutter,
  sharing,
  onShare,
  listen,
  onListen,
  paused,
  onPause,
  endHref,
}: {
  idle: boolean;
  onCall: () => void;
  shutter: ReactNode;
  sharing: boolean;
  onShare: (() => void) | null;
  listen: ListenState;
  onListen: () => void;
  paused: boolean;
  onPause: () => void;
  endHref: `/director/${string}`;
}) {
  const t = useTranslations("director.live.dock");
  const voice = useTranslations("director.live.voice");
  const listening = listen === "listening";
  const listenLabel = {
    unsupported: voice("unsupported"),
    blocked: voice("blocked"),
    listening: t("stopListen"),
    off: t("listen"),
  }[listen];
  // Faded controls can't be pressed by a stray touch; a keyboard focus brings them back.
  const fade = cn(
    "transition-opacity duration-700",
    idle &&
      "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100",
  );
  return (
    <nav
      aria-label={t("label")}
      className={cn(
        "mx-auto flex w-fit items-center gap-2.5 rounded-full p-2 transition-[background-color,box-shadow] duration-700",
        GLASS,
        idle && "bg-transparent shadow-none ring-transparent backdrop-blur-none",
      )}
    >
      <div className={cn("flex gap-2.5", fade)}>
        <CallButton onCall={onCall} />
        {onShare ? (
          <DockButton
            label={sharing ? t("stopShare") : t("share")}
            pressed={sharing}
            onClick={onShare}
          >
            {sharing ? (
              <ScreenShareOff className="size-5" aria-hidden />
            ) : (
              <ScreenShare className="size-5" aria-hidden />
            )}
          </DockButton>
        ) : null}
        <DockButton
          label={listenLabel}
          pressed={listening}
          onClick={onListen}
          disabled={listen === "unsupported"}
        >
          {listening ? (
            <Mic className="size-5" aria-hidden />
          ) : (
            <MicOff className="size-5" aria-hidden />
          )}
        </DockButton>
      </div>
      {shutter}
      <div className={cn("flex gap-2.5", fade)}>
        <DockButton label={paused ? t("resume") : t("pause")} pressed={paused} onClick={onPause}>
          {paused ? (
            <Play className="size-5 fill-current" aria-hidden />
          ) : (
            <Pause className="size-5 fill-current" aria-hidden />
          )}
        </DockButton>
        <Link
          href={endHref}
          aria-label={t("end")}
          title={t("end")}
          className="flex size-12 items-center justify-center rounded-full bg-record text-record-foreground transition-transform duration-200 active:scale-90"
        >
          <X className="size-5" aria-hidden />
        </Link>
      </div>
    </nav>
  );
}
