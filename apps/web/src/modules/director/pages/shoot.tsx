"use client";

import "../live.css";
import { useApiErrorMessage } from "@repo/client";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import type { Shot, ShotPlan } from "@repo/contracts/api";
import type { LiveToolCall } from "@repo/contracts/live";
import { required } from "@repo/contracts/objects";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/alert-dialog";
import { Button, buttonVariants } from "@repo/ui/components/button";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { Camera as CameraIcon, SendHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DirectorGate, YouTubeEmbed } from "@/modules/shorts";
import { DirectorCaptions, DirectorOrb, useLiveFailure } from "../components/director-captions";
import {
  CountdownNumber,
  FlipButton,
  GLASS,
  LeaveLink,
  RecordingPill,
  ShotCard,
  ShotProgress,
  Shutter,
  type ShutterMode,
} from "../components/shoot-parts";
import { TakeReview } from "../components/take-review";
import { Teleprompter } from "../components/teleprompter";
import { useCamera } from "../hooks/use-camera";
import { type DirectorLive, useDirectorLive } from "../hooks/use-director-live";
import { useLeaveGuard } from "../hooks/use-leave-guard";
import { useMemory } from "../hooks/use-memory";
import { useWakeLock } from "../hooks/use-screen";
import { nextPage, type Phase, type StudioShot, shotPage, useStudio } from "../hooks/use-studio";
import { type AudioMode, parseAudio } from "../lib/audio";
import { activeStep } from "../lib/timeline";

type Camera = ReturnType<typeof useCamera>;
type Studio = ReturnType<typeof useStudio>;

/** The original's audio, playing the shot's part while the member films along to it. */
function OriginalAudio({ videoId, shot }: { videoId: string; shot: Shot }) {
  const t = useTranslations("director.shoot");
  return (
    <div className="absolute top-20 right-3 w-16 overflow-hidden rounded-xl opacity-80 shadow-lg">
      <YouTubeEmbed
        videoId={videoId}
        title={t("original")}
        options={{
          autoplay: true,
          startSeconds: shot.sourceStartSeconds,
          endSeconds: shot.sourceEndSeconds,
        }}
        className="aspect-9/16 w-full"
      />
    </div>
  );
}

/**
 * Before anything turns on: what Director will do and that takes record only on the
 * shutter, then the one tap that opens the camera and brings Director in. The first
 * time it says the browser will ask for the camera and microphone next, so the prompt
 * never comes cold.
 */
function StartCard({
  first,
  ready,
  onStart,
}: {
  first: boolean;
  /** Whether it's known yet if Director can join here. */
  ready: boolean;
  onStart: () => void;
}) {
  const t = useTranslations("director.shoot");
  return (
    <div className="absolute inset-x-4 bottom-[max(1.5rem,env(safe-area-inset-bottom))] flex flex-col gap-3">
      <section
        aria-labelledby="shoot-intro"
        className={cn("live-motion animate-[live-rise_300ms_ease-out_both] rounded-3xl p-5", GLASS)}
      >
        <h1 id="shoot-intro" className="text-xl font-bold">
          {t("intro.title")}
        </h1>
        <p className="mt-2 text-[15px] leading-snug text-studio-foreground/85">
          {first ? t("intro.first") : t("intro.again")}
        </p>
      </section>
      <button
        type="button"
        onClick={onStart}
        disabled={!ready}
        className="h-14 rounded-full bg-studio-foreground text-lg font-semibold text-studio shadow-xl transition-transform active:scale-95 disabled:opacity-60"
      >
        {t("start")}
      </button>
    </div>
  );
}

/** No camera to show: why, and the way back to one. */
function CameraBlocked({ camera }: { camera: Camera }) {
  const t = useTranslations("director.shoot");
  const live = useTranslations("director.live");
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-studio p-8 text-center">
      <span className="flex size-20 items-center justify-center rounded-3xl bg-studio-foreground/10">
        <CameraIcon className="size-10" aria-hidden />
      </span>
      <h1 className="text-2xl font-bold">{t("cameraTitle")}</h1>
      <p role="alert" className="max-w-xs text-sm text-studio-foreground/80">
        {t(camera.state === "blocked" ? "cameraBlocked" : "cameraMissing")}
      </p>
      <button
        type="button"
        onClick={camera.start}
        className="min-h-12 rounded-full bg-studio-foreground px-6 font-semibold text-studio"
      >
        {live("retry")}
      </button>
    </div>
  );
}

/** Whether Director is joining or here: the top band's word on it. */
function DirectorPill({ live }: { live: DirectorLive }) {
  const t = useTranslations("director.live");
  if (live.state === "joining") {
    return (
      <p
        className={cn(
          "flex items-center gap-2 rounded-full py-1 pr-3 pl-1.5 text-sm font-semibold",
          GLASS,
        )}
      >
        <GeminiLoader as="span" size="sm" label={t("joining")} />
        <span aria-hidden>{t("joining")}</span>
      </p>
    );
  }
  if (live.state === "live") {
    return (
      <p
        className={cn(
          "flex items-center gap-2 rounded-full py-1 pr-3 pl-1.5 text-sm font-semibold",
          GLASS,
        )}
      >
        <DirectorOrb level={live.level} className="size-6" />
        <span>{t("here")}</span>
      </p>
    );
  }
  return null;
}

/**
 * When Director can't be there (or can't hear): why, that filming still works with the
 * shutter, and a way to try again where trying again could help.
 */
function LiveNotice({ live, liveOn }: { live: DirectorLive; liveOn: boolean }) {
  const t = useTranslations("director.live");
  const failureMessage = useLiveFailure();
  // Set only once Director has given up (or when the site has it off), never mid-retry.
  const failure = liveOn ? live.failure : "FEATURE_DISABLED";
  if (failure) {
    return (
      <div role="status" className={cn("rounded-2xl px-3.5 py-2.5 text-sm", GLASS)}>
        <p className="font-semibold">{failureMessage(failure)}</p>
        <p className="mt-0.5 text-studio-foreground/80">{t("stillFilm")}</p>
        {failure === "FEATURE_DISABLED" ? null : (
          <button
            type="button"
            onClick={live.start}
            className="mt-2 min-h-11 rounded-full bg-studio-foreground px-4 text-sm font-semibold text-studio"
          >
            {t("retry")}
          </button>
        )}
      </div>
    );
  }
  if (live.state === "live" && !live.hearing) {
    return (
      <p role="status" className={cn("rounded-2xl px-3.5 py-2.5 text-sm", GLASS)}>
        {t("deaf")}
      </p>
    );
  }
  return null;
}

/** The text box: anything typed goes to Director as the member's own words. */
function TellBox({ live }: { live: DirectorLive }) {
  const t = useTranslations("director.shoot.tell");
  const [text, setText] = useState("");
  const here = live.state === "live";
  const send = (event: FormEvent) => {
    event.preventDefault();
    const line = text.trim();
    // The box is only enabled while Director is here to read it.
    if (line) {
      live.say(line);
      setText("");
    }
  };
  return (
    <form
      onSubmit={send}
      className={cn("flex items-center gap-1 rounded-full py-1 pr-1 pl-4", GLASS)}
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label={t("label")}
        placeholder={here ? t("placeholder") : t("away")}
        disabled={!here}
        maxLength={2000}
        enterKeyHint="send"
        className="min-h-11 min-w-0 flex-1 bg-transparent text-[16px] placeholder:text-studio-foreground/60 focus:outline-none disabled:opacity-60"
      />
      <button
        type="submit"
        aria-label={t("send")}
        title={t("send")}
        disabled={!here || text.trim() === ""}
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-studio-foreground text-studio transition-transform active:scale-90 disabled:opacity-40"
      >
        <SendHorizontal className="size-5" aria-hidden />
      </button>
    </form>
  );
}

function shutterMode(phase: Phase, shot: Shot): ShutterMode {
  if (phase === "countdown") {
    return "cancel";
  }
  if (phase === "recording") {
    return "stop";
  }
  return shot.kind === "photo" ? "photo" : "record";
}

/** The bottom row: flip, the shutter, and a spacer that keeps the shutter centred. */
function Controls({
  shot,
  studio,
  camera,
  onFlip,
}: {
  shot: Shot;
  studio: Studio;
  camera: Camera;
  onFlip: () => void;
}) {
  const t = useTranslations("director.shoot.shutter");
  const mode = shutterMode(studio.phase, shot);
  const live = camera.state === "live";
  return (
    <div className="flex items-center justify-between px-6">
      <FlipButton onFlip={onFlip} disabled={!live || studio.phase !== "setup"} />
      <Shutter
        mode={mode}
        label={t(mode)}
        progress={studio.seconds / shot.durationSeconds}
        disabled={!live}
        onClick={studio.actions.shutter}
      />
      <span aria-hidden className="size-12" />
    </div>
  );
}

/** While a take records: Director stays quiet, and the line (or the step) stays near the lens. */
function RecordingFoot({ shot, studio, voice }: { shot: Shot; studio: Studio; voice: boolean }) {
  const t = useTranslations("director.shoot");
  const step = shot.steps[activeStep(shot.steps, studio.seconds)];
  return (
    <div className="flex flex-col gap-2">
      <p className={cn("w-fit rounded-full px-3 py-1 text-xs font-semibold", GLASS)}>
        {t("quiet")}
      </p>
      {voice && shot.script.length > 0 ? (
        <Teleprompter script={shot.script} seconds={studio.seconds} />
      ) : (
        <p
          className={cn("rounded-2xl px-3.5 py-2.5 text-[15px] font-semibold empty:hidden", GLASS)}
        >
          {step?.instruction}
        </p>
      )}
    </div>
  );
}

interface Screen {
  props: StudioShot;
  studio: Studio;
  camera: Camera;
  live: DirectorLive;
  liveOn: boolean;
  onFlip: () => void;
  onLeave: (event: { preventDefault: () => void }) => void;
}

/** Everything over the picture once the shoot has started, in a top and a bottom band. */
function Overlay({ props, studio, camera, live, liveOn, onFlip, onLeave }: Screen) {
  const t = useTranslations("director.shoot");
  const { shot, index, count, videoId, audio } = props;
  const recording = studio.phase === "recording";
  const setup = studio.phase === "setup";
  return (
    <>
      <div className="absolute inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          {recording ? (
            <RecordingPill seconds={studio.seconds} />
          ) : (
            <ShotProgress index={index} count={count} />
          )}
          <div className="flex items-center gap-2">
            <DirectorPill live={live} />
            <LeaveLink videoId={videoId} onClick={onLeave} />
          </div>
        </div>
        {setup ? <ShotCard shot={shot} index={index} /> : null}
        {setup ? <LiveNotice live={live} liveOn={liveOn} /> : null}
      </div>
      <CountdownNumber seconds={studio.countdown} />
      {recording && audio === "original" ? <OriginalAudio videoId={videoId} shot={shot} /> : null}
      {studio.failed ? (
        <p
          role="alert"
          className="absolute inset-x-6 top-1/2 rounded-2xl bg-studio/85 p-3 text-center text-sm text-studio-error"
        >
          {t("recordFailed")}
        </p>
      ) : null}
      <div className="absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-col gap-3">
        {recording ? (
          <RecordingFoot shot={shot} studio={studio} voice={audio === "voice"} />
        ) : (
          <DirectorCaptions captions={live.captions} level={live.level} />
        )}
        {setup && liveOn ? <TellBox live={live} /> : null}
        <Controls shot={shot} studio={studio} camera={camera} onFlip={onFlip} />
      </div>
    </>
  );
}

/**
 * Director's tool calls, done the way the member's own taps are, and answered with what
 * really happened: nothing changes shot or camera while a take is under way.
 */
type ToolHandler = (id: string, call: LiveToolCall) => void;

function useTools(
  tools: { current: ToolHandler },
  screen: Omit<Screen, "liveOn" | "onFlip" | "onLeave">,
) {
  const router = useRouter();
  useLayoutEffect(() => {
    const { props, studio, camera, live } = screen;
    tools.current = (id, call) => {
      if (studio.phase !== "setup") {
        return live.answer(id, "busy");
      }
      if (call.name === "go_to_shot") {
        if (call.shot !== props.index) {
          router.push(shotPage(props.videoId, call.shot, props.audio, props.retake));
        }
        return live.answer(id, "done");
      }
      if (camera.state !== "live") {
        return live.answer(id, "no_camera");
      }
      camera.face(call.to);
      live.answer(id, "done");
    };
  });
}

/**
 * The member flipped the camera: once the other camera's picture is up, Director is told
 * and looks at the new view. A flip Director asked for itself isn't announced back to it.
 */
function useMemberFlip(camera: Camera, live: DirectorLive) {
  const flipped = useRef(false);
  const latest = useRef({ live, facing: camera.facing });
  useLayoutEffect(() => {
    latest.current = { live, facing: camera.facing };
  });
  const { stream } = camera;
  useEffect(() => {
    if (stream && flipped.current) {
      flipped.current = false;
      latest.current.live.camera(latest.current.facing);
    }
  }, [stream]);
  return () => {
    flipped.current = true;
    camera.flip();
  };
}

interface ShootProps {
  videoId: string;
  plan: ShotPlan;
  index: number;
  audio: AudioMode;
  retake: boolean;
}

/**
 * The shoot's moving parts, wired together: the camera (open with the microphone for the
 * whole shoot when takes record the member's voice, so moving between shots never
 * reopens it), Director live, and the take, each telling the others what happened.
 */
function useShoot({ videoId, plan, index, audio, retake }: ShootProps) {
  const camera = useCamera(audio === "voice");
  // Moving on after a kept take goes through the leave guard (made below, from the take).
  const guard = useRef<Pick<ReturnType<typeof useLeaveGuard>, "go">>({ go: () => undefined });
  const props: StudioShot = {
    videoId,
    shot: required(plan.shots[index], "the shot"),
    index,
    count: plan.shots.length,
    audio,
    retake,
  };
  const tools = useRef<ToolHandler>(() => undefined);
  const live = useDirectorLive({
    videoId,
    shotIndex: index,
    video: camera.video,
    onTool: (id, call) => tools.current(id, call),
  });
  const studio = useStudio(props, camera, {
    onCountdown: () => live.take("countdown"),
    onCancelled: () => live.take("cancelled"),
    onRecording: () => live.take("recording"),
    onRecorded: () => live.take("recorded"),
    onDiscarded: () => live.take("discarded"),
    onKept: () => guard.current.go(nextPage(props)),
  });
  const leaving = useLeaveGuard({
    guarded: studio.phase !== "setup",
    away: `/director/${videoId}`,
    halt: studio.actions.halt,
  });
  useLayoutEffect(() => {
    guard.current = leaving;
  });
  useTools(tools, { props, studio, camera, live });
  const onFlip = useMemberFlip(camera, live);
  const { hold } = live;
  const quiet = studio.phase === "countdown" || studio.phase === "recording";
  // Director's voice would talk over the 3-2-1 and end up in the take: it's held (dropped,
  // and not captioned) from the first number to the take's end.
  useEffect(() => hold(quiet), [hold, quiet]);
  useWakeLock();
  return { props, camera, live, studio, onFlip, leaving };
}

/** "Leave? This take isn't kept yet.", with Leave and Stay. */
function LeaveDialog({ leaving }: { leaving: ReturnType<typeof useLeaveGuard> }) {
  const t = useTranslations("director.shoot.leaving");
  return (
    // Only ever closed from inside (Stay, Escape, a tap outside): each of those means stay.
    <AlertDialog open={leaving.asking} onOpenChange={() => leaving.stay()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("stay")}</AlertDialogCancel>
          <Button variant="destructive" onClick={leaving.confirm}>
            {t("leave")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The member's take on screen to watch back, with what Director says about it. */
function Review({ shoot }: { shoot: ReturnType<typeof useShoot> }) {
  const errorMessage = useApiErrorMessage();
  const { studio, live, props } = shoot;
  if (!studio.take || (studio.phase !== "preview" && studio.phase !== "sending")) {
    return null;
  }
  return (
    <TakeReview
      take={studio.take}
      script={props.shot.script}
      sending={studio.phase === "sending"}
      error={studio.submit.error ? errorMessage(studio.submit.error) : null}
      onAgain={studio.actions.again}
      onKeep={studio.actions.use}
      captions={<DirectorCaptions captions={live.captions} level={live.level} />}
      tell={live.state === "live" ? <TellBox live={live} /> : null}
    />
  );
}

/**
 * The shoot screen for one short: one full-bleed camera that stays open across every
 * shot, Director live beside the member the whole time, and the shutter as the one way
 * a take starts.
 */
function ShootScreen(shootProps: ShootProps) {
  const system = useSystemInfoQuery();
  const liveOn = system.data?.features.live === true;
  const memory = useMemory();
  const [started, setStarted] = useState(false);
  const shoot = useShoot(shootProps);
  const { camera, live, studio } = shoot;
  const start = () => {
    camera.start();
    if (liveOn) {
      live.start();
    }
    memory.record({ type: "started" });
    setStarted(true);
  };
  const reviewing = studio.phase === "preview" || studio.phase === "sending";
  const blocked = camera.state === "blocked" || camera.state === "missing";
  return (
    <div className="fixed inset-0 overflow-hidden bg-studio text-studio-foreground">
      <div className="relative mx-auto h-full w-full max-w-[calc(100dvh*9/16)] overflow-hidden">
        <video
          ref={camera.video}
          autoPlay
          muted
          playsInline
          aria-hidden
          className={cn(
            "absolute inset-0 size-full object-cover",
            camera.facing === "front" && "-scale-x-100",
          )}
        />
        {started ? null : (
          <StartCard
            first={memory.before.sessions === 0}
            ready={system.data !== undefined}
            onStart={start}
          />
        )}
        {started && !blocked && !reviewing ? (
          <Overlay
            props={shoot.props}
            studio={studio}
            camera={camera}
            live={live}
            liveOn={liveOn}
            onFlip={shoot.onFlip}
            onLeave={shoot.leaving.leave}
          />
        ) : null}
        <Review shoot={shoot} />
        <LeaveDialog leaving={shoot.leaving} />
        {blocked ? <CameraBlocked camera={camera} /> : null}
      </div>
    </div>
  );
}

function Shoot({
  videoId,
  shot,
  audio,
  back,
}: {
  videoId: string;
  shot: string | undefined;
  audio: string | undefined;
  back?: string | undefined;
}) {
  const t = useTranslations("director");
  const common = useTranslations("common");
  const plan = useDirectorPlanQuery(videoId);
  const ready: ShotPlan | null = plan.data?.status === "ready" ? plan.data.plan : null;
  if (plan.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center bg-studio">
        <GeminiLoader label={common("loading")} />
      </div>
    );
  }
  if (!ready || ready.shots.length === 0) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
        <p>{t("progress.pending")}</p>
        <Link href={`/director/${videoId}`} className={buttonVariants({ variant: "secondary" })}>
          {t("back")}
        </Link>
      </div>
    );
  }
  const index = Math.min(
    ready.shots.length - 1,
    Math.max(0, Number.parseInt(shot ?? "0", 10) || 0),
  );
  // One screen for the whole shoot: moving to another shot changes only what it shows.
  return (
    <ShootScreen
      videoId={videoId}
      plan={ready}
      index={index}
      audio={parseAudio(audio, ready)}
      retake={back === "edit"}
    />
  );
}

/** The shoot screen: the camera, Director live, and the shutter, one shot at a time. */
export function ShootPage(props: {
  videoId: string;
  shot: string | undefined;
  audio: string | undefined;
  /** "edit": a retake asked for from the editor, which goes back there once kept. */
  back?: string | undefined;
}) {
  return (
    <DirectorGate>
      <Shoot {...props} />
    </DirectorGate>
  );
}
