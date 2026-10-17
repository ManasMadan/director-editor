"use client";

import "@fontsource/gochi-hand/400.css";
import "../live.css";
import { useApiErrorMessage } from "@repo/client";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import type { Shot, ShotPlan } from "@repo/contracts/api";
import { buttonVariants } from "@repo/ui/components/button";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { Camera, MonitorUp, SwitchCamera } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DirectorGate, YouTubeEmbed } from "@/modules/shorts";
import { DirectorsCut } from "../components/directors-cut";
import { DoodleLayer } from "../components/doodle-layer";
import { CallCaptions, CallDock, CallPill, useCallFailure } from "../components/live-call";
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
import { type CallFailure, useLiveCall } from "../hooks/use-live-call";
import { useSpeaking } from "../hooks/use-live-director";
import { useSession } from "../hooks/use-session";
import { nextPage, type StudioShot, shotPage } from "../hooks/use-studio";
import { parseAudio } from "../lib/audio";
import { restCallAudio } from "../lib/call-audio";
import type { LiveTool } from "../lib/live-call";
import { activeStep } from "../lib/timeline";

type Session = ReturnType<typeof useSession>;
type Call = ReturnType<typeof useLiveCall>;

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
function ViewportTop({ session, shot, call }: { session: Session; shot: Shot; call: Call | null }) {
  const t = useTranslations("director.shoot");
  const { studio, seen } = session;
  if (studio.phase !== "setup" && studio.phase !== "countdown") {
    return null;
  }
  return (
    <div
      className={cn(
        "absolute inset-x-3 flex items-start justify-between gap-2",
        // On a call the header floats over the viewport's top.
        call ? "top-16" : "top-3",
      )}
    >
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

/**
 * The foot of the viewport: Director's caption (both sides', on a call), or while
 * recording, the step and the lines.
 */
function ViewportFoot({
  session,
  shot,
  voice,
  call,
}: {
  session: Session;
  shot: Shot;
  voice: boolean;
  call: Call | null;
}) {
  const t = useTranslations("director");
  const talking = useSpeaking();
  const { studio } = session;
  const sharing = studio.camera.source === "screen";
  // On a call the dock floats over the viewport's foot.
  const bottom = call ? "bottom-28" : "bottom-3";
  if (studio.phase === "recording") {
    const step = shot.steps[activeStep(shot.steps, studio.seconds)];
    return (
      <div className={cn("live-motion absolute inset-x-3 flex flex-col gap-2", bottom)}>
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
    <div className={cn("absolute inset-x-3 flex items-end gap-2", bottom)}>
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
        {call ? (
          <CallCaptions captions={call.captions} level={call.level} />
        ) : (
          <DirectorCaption
            line={studio.phase === "countdown" ? null : session.director.line}
            talking={talking}
            heard={session.voice.words}
            listening={session.voice.state === "listening"}
          />
        )}
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
function Viewport({
  session,
  props,
  call,
}: {
  session: Session;
  props: StudioShot;
  call: Call | null;
}) {
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
      <ViewportTop session={session} shot={props.shot} call={call} />
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
        <ViewportFoot
          session={session}
          shot={props.shot}
          voice={props.audio === "voice"}
          call={call}
        />
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

/**
 * The call with Director on this shot. Director's tool calls drive the studio the way the
 * member's own spoken requests do; once the member has called, the next shot's call
 * starts by itself; and a call that fails says why and hands the shot back to Director
 * Live, with the take on screen and the takes already sent untouched.
 */
function useCall(
  props: StudioShot,
  session: Session,
  { calling, setCalling }: { calling: boolean; setCalling: (calling: boolean) => void },
) {
  const t = useTranslations("director.call");
  const failureMessage = useCallFailure();
  const router = useRouter();
  const { studio, requests } = session;
  const tools: Record<LiveTool, () => void> = {
    start_recording: requests.action,
    stop_recording: requests.cut,
    retake: requests.again,
    // The take on screen is kept (and the next shot opens once it's sent); before a take,
    // Director is skipping this shot.
    next_shot: () => {
      if (studio.phase === "preview") {
        requests.keep();
      }
      if (studio.phase === "setup") {
        router.push(nextPage(props));
      }
    },
    previous_shot: () => {
      if (props.index > 0) {
        router.push(shotPage(props.videoId, props.index - 1, props.audio));
      }
    },
  };
  const call = useLiveCall({
    videoId: props.videoId,
    shotIndex: props.index,
    video: studio.camera.video,
    onTool: (name) => tools[name](),
    onEnd: (failure: CallFailure | null) => {
      if (failure) {
        // At the top: at the foot it would cover the shutter the member is about to need.
        toast.error(failureMessage(failure), {
          description: t("fallback"),
          position: "top-center",
        });
      }
      setCalling(false);
    },
  });
  const { state, start } = call;
  useEffect(() => {
    if (calling && state === "idle") {
      start();
    }
  }, [calling, state, start]);
  // Started from the tap itself, so the browser lets the call make sound.
  const ring = () => {
    setCalling(true);
    start();
  };
  return { call: calling ? call : null, ring };
}

/** Above the viewport: the shots, Live (or the call), the countdown and Director's voice. */
function StudioHeader({
  session,
  props,
  call,
}: {
  session: Session;
  props: StudioShot;
  call: Call | null;
}) {
  const talking = useSpeaking();
  const { studio, memory, actions } = session;
  const listening = session.voice.state === "listening";
  return (
    <header
      className={cn(
        "live-motion relative grid w-full max-w-md grid-cols-[1fr_auto_1fr] items-center",
        call && "absolute inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-10 mx-auto px-3",
      )}
    >
      <ShotDots index={props.index} count={props.count} />
      {call ? (
        <CallPill state={call.state} level={call.level} />
      ) : (
        <LivePill
          mode={liveMode(studio.phase === "recording", session.paused)}
          talking={talking || (listening && session.voice.words !== "")}
          seconds={studio.seconds}
          onDevice={session.seen.scene.offline}
        />
      )}
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
        {call ? null : (
          <VoiceButton on={memory.speak} onToggle={() => actions.speak(!memory.speak)} />
        )}
      </div>
    </header>
  );
}

/** Under the viewport: Director Live's dock, or on a call, mute and hang up. */
function StudioDock({
  session,
  props,
  call,
  ring,
}: {
  session: Session;
  props: StudioShot;
  call: Call | null;
  ring: () => void;
}) {
  const { studio, memory, actions } = session;
  const { camera } = studio;
  const reviewing = studio.phase === "preview" || studio.phase === "sending";
  const shutter = <SessionShutter session={session} shot={props.shot} />;
  return (
    <div
      className={cn(
        "relative h-[5.75rem]",
        reviewing && "invisible",
        call && "absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-10 h-auto",
      )}
    >
      {call ? (
        <CallDock
          shutter={shutter}
          muted={call.muted}
          canMute={call.state === "live"}
          onMute={call.toggleMute}
          onEnd={call.end}
        />
      ) : (
        <LiveDock
          idle={session.idle}
          onCall={ring}
          shutter={shutter}
          sharing={camera.source === "screen"}
          onShare={shareAction(camera)}
          listen={session.voice.state}
          onListen={() => actions.listen(!memory.listen)}
          paused={session.paused}
          onPause={() => actions.pause(!session.paused)}
          endHref={`/director/${props.videoId}`}
        />
      )}
    </div>
  );
}

function Studio({
  calling,
  setCalling,
  ...props
}: StudioShot & { calling: boolean; setCalling: (calling: boolean) => void }) {
  const session = useSession(props, calling);
  const { call, ring } = useCall(props, session, { calling, setCalling });
  const talking = useSpeaking();
  const { studio } = session;
  const recording = studio.phase === "recording";
  const listening = session.voice.state === "listening";
  const step = activeStep(props.shot.steps, studio.seconds);
  return (
    <div
      className={cn(
        "relative flex min-h-dvh flex-col items-center justify-center gap-3 overflow-hidden px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] text-studio-foreground",
        // On a call the camera has the whole screen, the controls floating over it.
        call && "p-0",
      )}
    >
      <LiveBackdrop stream={studio.camera.stream} />
      <StudioHeader session={session} props={props} call={call} />
      <LiveViewport
        glowing={call ? call.speaking : talking || listening}
        recording={recording}
        beat={recording ? step + 1 : 0}
        full={call !== null}
      >
        <Viewport session={session} props={props} call={call} />
      </LiveViewport>
      <StudioDock session={session} props={props} call={call} ring={ring} />
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
  const common = useTranslations("common");
  const plan = useDirectorPlanQuery(videoId);
  // Above the shot's own screen, so a call carries on to the next shot.
  const [calling, setCalling] = useState(false);
  useEffect(() => restCallAudio, []);
  if (plan.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center bg-live-deep">
        <GeminiLoader label={common("loading")} />
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
      calling={calling}
      setCalling={setCalling}
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
