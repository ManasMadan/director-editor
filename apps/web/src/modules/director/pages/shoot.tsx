"use client";

import "@fontsource/gochi-hand/400.css";
import "../live.css";
import { useApiErrorMessage } from "@repo/client";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import type { Shot, ShotPlan } from "@repo/contracts/api";
import { buttonVariants } from "@repo/ui/components/button";
import { Spinner } from "@repo/ui/components/spinner";
import { cn } from "@repo/ui/lib/utils";
import { Camera, MonitorUp, SwitchCamera } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { DirectorGate, YouTubeEmbed } from "@/modules/shorts";
import { DirectorsCut } from "../components/directors-cut";
import { DoodleLayer } from "../components/doodle-layer";
import { DirectorCaption } from "../components/live-caption";
import { LiveDock, Shutter } from "../components/live-dock";
import {
  GLASS,
  type LiveMode,
  LivePill,
  ReadyCheck,
  ShotDots,
  StatusPill,
  TimerButton,
  VoiceButton,
} from "../components/live-hud";
import { CountdownPulse, LiveBackdrop, LiveViewport } from "../components/live-stage";
import { Teleprompter } from "../components/teleprompter";
import { useSpeaking } from "../hooks/use-live-director";
import { useSession } from "../hooks/use-session";
import type { StudioShot } from "../hooks/use-studio";
import { parseAudio } from "../lib/audio";
import { activeStep } from "../lib/timeline";

type Session = ReturnType<typeof useSession>;

/** The original's audio, playing the shot's part while the member films along to it. */
function OriginalAudio({ videoId, shot }: { videoId: string; shot: Shot }) {
  const t = useTranslations("director.shoot");
  return (
    <div className="absolute top-16 right-3 w-16 overflow-hidden rounded-xl opacity-80 shadow-lg">
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

/** No camera to show: why, and the way back to one. */
function CameraBlocked({ session }: { session: Session }) {
  const t = useTranslations("director");
  const { camera } = session.studio;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="flex size-20 -rotate-6 items-center justify-center rounded-3xl bg-doodle-paper text-studio shadow-xl">
        <Camera className="size-10" aria-hidden />
      </span>
      <h2 className="font-[family-name:var(--font-hand)] text-3xl">{t("live.camera.title")}</h2>
      <p role="alert" className="max-w-xs text-sm text-studio-foreground/80">
        {t(camera.state === "blocked" ? "shoot.cameraBlocked" : "shoot.cameraMissing")}
      </p>
      <button
        type="button"
        onClick={() => void camera.start()}
        className="rounded-full bg-studio-foreground px-6 py-3 font-semibold text-studio"
      >
        {t("live.camera.retry")}
      </button>
    </div>
  );
}

/** The top of the viewport: which take and shot size, the ready check, the tilt request. */
function ViewportTop({ session, shot }: { session: Session; shot: Shot }) {
  const t = useTranslations("director.shoot");
  const { studio, seen } = session;
  if (studio.phase !== "setup" && studio.phase !== "countdown") {
    return null;
  }
  return (
    <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-2">
      <div className="flex flex-col items-start gap-1.5">
        <StatusPill take={session.take} size={shot.framing.shotSize} />
        {seen.ask ? (
          <button
            type="button"
            onClick={() => void seen.ask?.()}
            className={cn("rounded-full px-3 py-1.5 text-xs font-semibold", GLASS)}
          >
            {t("useTilt")}
          </button>
        ) : null}
      </div>
      {studio.camera.source === "camera" ? <ReadyCheck readiness={seen.readiness} /> : null}
    </div>
  );
}

/** The foot of the viewport: Director's caption, or while recording, the step and the lines. */
function ViewportFoot({ session, shot, voice }: { session: Session; shot: Shot; voice: boolean }) {
  const t = useTranslations("director");
  const talking = useSpeaking();
  const { studio } = session;
  const sharing = studio.camera.source === "screen";
  if (studio.phase === "recording") {
    const step = shot.steps[activeStep(shot.steps, studio.seconds)];
    return (
      <div className="live-motion absolute inset-x-3 bottom-3 flex flex-col gap-2">
        {step ? (
          <p
            key={step.atSeconds}
            className={cn(
              "animate-[live-rise_300ms_ease-out_both] rounded-2xl px-3.5 py-2.5 text-[15px] font-semibold",
              GLASS,
            )}
          >
            {step.instruction}
          </p>
        ) : null}
        {voice ? <Teleprompter script={shot.script} seconds={studio.seconds} /> : null}
      </div>
    );
  }
  return (
    <div className="absolute inset-x-3 bottom-3 flex items-end gap-2">
      <div className="min-w-0 flex-1">
        {sharing ? (
          <p
            className={cn(
              "mb-1.5 flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
              GLASS,
            )}
          >
            <MonitorUp className="size-3.5" aria-hidden />
            {t("live.screen.sharing")}
          </p>
        ) : null}
        <DirectorCaption
          line={studio.phase === "countdown" ? null : session.director.line}
          talking={talking}
          heard={session.voice.words}
          listening={session.voice.state === "listening"}
        />
      </div>
      {sharing ? null : (
        <button
          type="button"
          aria-label={t("live.dock.flip")}
          title={t("live.dock.flip")}
          onClick={studio.camera.flip}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90",
            GLASS,
          )}
        >
          <SwitchCamera className="size-5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** Inside the capsule: the picture, the doodles, and whatever the moment needs over them. */
function Viewport({ session, props }: { session: Session; props: StudioShot }) {
  const t = useTranslations("director");
  const errorMessage = useApiErrorMessage();
  const { studio, cut } = session;
  const { camera } = studio;
  const mirrored = camera.facing === "front" && camera.source === "camera";
  const reviewing = studio.phase === "preview" || studio.phase === "sending";
  const blocked = camera.state === "blocked" || camera.state === "missing";
  return (
    <>
      <video
        ref={camera.video}
        autoPlay
        muted
        playsInline
        aria-hidden
        className={cn(
          "absolute inset-0 size-full",
          camera.source === "screen" ? "object-contain" : "object-cover",
          mirrored && "-scale-x-100",
        )}
      />
      {reviewing ? null : <DoodleLayer scene={session.scene} />}
      {blocked ? <CameraBlocked session={session} /> : null}
      <ViewportTop session={session} shot={props.shot} />
      <CountdownPulse seconds={studio.countdown} />
      {studio.phase === "recording" && props.audio === "original" ? (
        <OriginalAudio videoId={props.videoId} shot={props.shot} />
      ) : null}
      {reviewing && studio.take && cut ? (
        <DirectorsCut
          take={studio.take}
          cut={cut}
          script={props.shot.script}
          sending={studio.phase === "sending"}
          error={studio.submit.error ? errorMessage(studio.submit.error) : null}
          onAgain={() => session.actions.retake(cut)}
          onKeep={() => session.actions.use(cut)}
        />
      ) : (
        <ViewportFoot session={session} shot={props.shot} voice={props.audio === "voice"} />
      )}
      {studio.failed ? (
        <p
          role="alert"
          className="absolute inset-x-6 top-1/2 rounded-2xl bg-studio/85 p-3 text-center text-sm text-studio-error"
        >
          {t("shoot.recordFailed")}
        </p>
      ) : null}
    </>
  );
}

const SHUTTER = { video: "record", photo: "photo" } as const;

/** The shutter for this moment: record (or take the photo), then stop. */
function SessionShutter({ session, shot }: { session: Session; shot: Shot }) {
  const t = useTranslations("director");
  const { studio } = session;
  const recording = studio.phase === "recording";
  const sharing = studio.camera.source === "screen";
  const label = sharing
    ? t("live.dock.sharingNoRecord")
    : t(shot.kind === "photo" ? "shoot.photo" : "record");
  return (
    <Shutter
      mode={recording ? "stop" : SHUTTER[shot.kind]}
      label={recording ? t("shoot.stop") : label}
      progress={studio.seconds / shot.durationSeconds}
      disabled={
        !recording && (studio.camera.state !== "live" || studio.phase !== "setup" || sharing)
      }
      onClick={recording ? studio.actions.stop : session.actions.record}
    />
  );
}

const liveMode = (recording: boolean, paused: boolean): LiveMode => {
  if (recording) {
    return "recording";
  }
  return paused ? "paused" : "live";
};

/** The dock's screen button: share, or stop sharing; nothing where screens can't be shared. */
function shareAction(camera: Session["studio"]["camera"]) {
  const { share } = camera;
  if (!share) {
    return null;
  }
  return camera.source === "screen" ? camera.stopSharing : () => void share();
}

function Studio(props: StudioShot) {
  const session = useSession(props);
  const talking = useSpeaking();
  const { studio, memory, actions } = session;
  const { camera } = studio;
  const recording = studio.phase === "recording";
  const reviewing = studio.phase === "preview" || studio.phase === "sending";
  const listening = session.voice.state === "listening";
  const step = activeStep(props.shot.steps, studio.seconds);
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center gap-3 overflow-hidden px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] text-studio-foreground">
      <LiveBackdrop stream={camera.stream} />
      <header className="live-motion relative grid w-full max-w-md grid-cols-[1fr_auto_1fr] items-center">
        <ShotDots index={props.index} count={props.count} />
        <LivePill
          mode={liveMode(recording, session.paused)}
          talking={talking || (listening && session.voice.words !== "")}
          seconds={studio.seconds}
          onDevice={session.seen.scene.offline}
        />
        <div
          className={cn(
            "flex justify-end gap-2 transition-opacity duration-700",
            session.idle && "opacity-0",
          )}
        >
          <TimerButton
            chosen={memory.countdown}
            seconds={session.countdownFrom}
            onChoose={actions.countdown}
          />
          <VoiceButton on={memory.speak} onToggle={() => actions.speak(!memory.speak)} />
        </div>
      </header>
      <LiveViewport
        glowing={talking || listening}
        recording={recording}
        beat={recording ? step + 1 : 0}
      >
        <Viewport session={session} props={props} />
      </LiveViewport>
      <div className={cn("relative h-[5.75rem]", reviewing && "invisible")}>
        <LiveDock
          idle={session.idle}
          shutter={<SessionShutter session={session} shot={props.shot} />}
          sharing={camera.source === "screen"}
          onShare={shareAction(camera)}
          listen={session.voice.state}
          onListen={() => actions.listen(!memory.listen)}
          paused={session.paused}
          onPause={() => actions.pause(!session.paused)}
          endHref={`/director/${props.videoId}`}
        />
      </div>
    </div>
  );
}

function Shoot({
  videoId,
  shot,
  audio,
}: {
  videoId: string;
  shot: string | undefined;
  audio: string | undefined;
}) {
  const t = useTranslations("director");
  const plan = useDirectorPlanQuery(videoId);
  if (plan.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center bg-live-deep">
        <Spinner />
      </div>
    );
  }
  const ready: ShotPlan | null = plan.data?.status === "ready" ? plan.data.plan : null;
  const index = ready
    ? Math.min(ready.shots.length - 1, Math.max(0, Number.parseInt(shot ?? "0", 10) || 0))
    : 0;
  const current = ready?.shots[index];
  if (!ready || !current) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
        <p>{t("progress.pending")}</p>
        <Link href={`/director/${videoId}`} className={buttonVariants({ variant: "secondary" })}>
          {t("back")}
        </Link>
      </div>
    );
  }
  // A fresh session per shot: its camera, recorder and guidance start over.
  return (
    <Studio
      key={index}
      videoId={videoId}
      shot={current}
      index={index}
      count={ready.shots.length}
      audio={parseAudio(audio, ready)}
    />
  );
}

/** Director Live: the camera, one shot at a time, with Director guiding every take. */
export function ShootPage(props: {
  videoId: string;
  shot: string | undefined;
  audio: string | undefined;
}) {
  return (
    <DirectorGate>
      <Shoot {...props} />
    </DirectorGate>
  );
}
