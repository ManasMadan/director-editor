"use client";

import { useApiErrorMessage } from "@repo/client";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import type { CameraMove, SceneCheck, Shot, ShotPlan } from "@repo/contracts/api";
import { buttonVariants } from "@repo/ui/components/button";
import { Spinner } from "@repo/ui/components/spinner";
import { cn } from "@repo/ui/lib/utils";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { DirectorGate, YouTubeEmbed } from "@/modules/shorts";
import { CaptureBar } from "../components/capture-bar";
import { DoodleLayer } from "../components/doodle-layer";
import { GuideChips } from "../components/guide-chips";
import { StudioHud } from "../components/studio-hud";
import { TakePreview } from "../components/take-preview";
import { Teleprompter } from "../components/teleprompter";
import { useDirections } from "../hooks/use-directions";
import { usePose } from "../hooks/use-pose";
import { useSceneGuide } from "../hooks/use-scene-guide";
import { type StudioShot, useStudio } from "../hooks/use-studio";
import { useTilt } from "../hooks/use-tilt";
import { parseAudio } from "../lib/audio";
import type { DoodleScene } from "../lib/doodle";
import { bodyBox, framingHint } from "../lib/framing";
import { POSE_MATCH, poseScore, targetBody } from "../lib/pose";
import { activeStep } from "../lib/timeline";

type StudioState = ReturnType<typeof useStudio>;

/** The pose outline and framing hint, for a shot with a person in it. */
function useBodyGuides(shot: Shot, video: StudioState["camera"]["video"], live: boolean) {
  const target = useMemo(() => targetBody(shot.pose), [shot]);
  const tracksBody = shot.pose.keypoints.length > 0;
  const pose = usePose(video, tracksBody && live);
  const score = pose.body ? poseScore(target, pose.body) : null;
  const box = pose.body ? bodyBox(pose.body) : null;
  return {
    target,
    state: pose.state,
    matched: score !== null && score >= POSE_MATCH,
    framing: tracksBody ? framingHint(shot.framing.subject, box, shot.camera) : null,
    // Where they stand: the walking arrow starts at their feet.
    person: box ? { x: box.x + box.width / 2, y: Math.min(0.94, box.y + box.height) } : null,
  };
}

type Guides = ReturnType<typeof useBodyGuides>;
const previewing = (phase: StudioState["phase"]) => phase === "preview" || phase === "sending";

/**
 * What the doodles show now: getting into place (the walk to the spot, the framing) until
 * recording starts, then the step's camera move.
 */
function useDoodleScene(
  shot: Shot,
  guides: Guides,
  { setup, scene, move }: { setup: boolean; scene: SceneCheck | null; move: CameraMove | null },
): DoodleScene {
  const t = useTranslations("director.shoot.doodle");
  const check = setup ? scene : null;
  const meters = check && !check.inPlace ? check.distanceMeters : null;
  return {
    shot,
    target: guides.target,
    matched: guides.matched,
    mirrored: shot.camera === "front",
    person: guides.person,
    framing: setup ? guides.framing : null,
    scene: check,
    move,
    labels: {
      spot: t("standHere"),
      meters: meters === null ? null : t("meters", { meters }),
      move: move === null || move === "static" ? null : t(`move.${move}`),
    },
  };
}

/** The camera, with Director's doodles over it, or the take once it's recorded. */
function Stage({
  studio,
  shot,
  doodles,
}: {
  studio: StudioState;
  shot: Shot;
  doodles: DoodleScene;
}) {
  const t = useTranslations("director.shoot");
  const locale = useLocale();
  const front = shot.camera === "front";
  const blocked = studio.camera.state === "blocked" || studio.camera.state === "missing";
  return (
    <>
      <video
        ref={studio.camera.video}
        autoPlay
        muted
        playsInline
        aria-hidden
        className={cn("absolute inset-0 size-full object-cover", front && "-scale-x-100")}
      />
      {previewing(studio.phase) && studio.take ? (
        <TakePreview take={studio.take} label={t("preview")} script={shot.script} lang={locale} />
      ) : null}
      {previewing(studio.phase) ? null : <DoodleLayer scene={doodles} />}
      {blocked ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <p role="alert">
            {t(studio.camera.state === "blocked" ? "cameraBlocked" : "cameraMissing")}
          </p>
          <button
            type="button"
            onClick={() => void studio.camera.start()}
            className={buttonVariants({ variant: "secondary" })}
          >
            {t("start")}
          </button>
        </div>
      ) : null}
      {studio.countdown === null ? null : (
        <p
          aria-live="assertive"
          className="absolute inset-0 flex items-center justify-center text-8xl font-black drop-shadow-lg"
        >
          {studio.countdown}
        </p>
      )}
    </>
  );
}

/** The original's audio, playing the shot's part while the member films along to it. */
function OriginalAudio({ videoId, shot }: { videoId: string; shot: Shot }) {
  const t = useTranslations("director.shoot");
  return (
    <div className="absolute top-28 right-4 w-20 overflow-hidden rounded-lg opacity-80">
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

/** What went wrong with the take, if anything: sending it, or taking it. */
function captureError(
  studio: StudioState,
  errorMessage: (error: unknown) => string,
  recordFailed: string,
) {
  if (studio.submit.error) {
    return errorMessage(studio.submit.error);
  }
  return studio.failed ? recordFailed : null;
}

/** The bottom of the screen: the step, the teleprompter, and the capture controls. */
function Controls({
  studio,
  shot,
  step,
  voice,
}: {
  studio: StudioState;
  shot: Shot;
  step: Shot["steps"][number] | undefined;
  voice: boolean;
}) {
  const t = useTranslations("director.shoot");
  const errorMessage = useApiErrorMessage();
  const during = !previewing(studio.phase);
  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 bg-linear-to-t from-studio/90 to-transparent p-4 pt-16 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      {during && step ? (
        <p
          className="rounded-2xl bg-studio/70 px-4 py-3 text-base font-semibold backdrop-blur"
          aria-live="polite"
        >
          <span className="mr-2 text-xs font-medium text-studio-foreground/60">
            {t("step", { index: shot.steps.indexOf(step) + 1 })}
          </span>
          {step.instruction}
        </p>
      ) : null}
      {voice && during ? <Teleprompter script={shot.script} seconds={studio.seconds} /> : null}
      {!voice && studio.phase === "setup" ? (
        <p className="text-center text-xs text-studio-foreground/70">{t("original")}</p>
      ) : null}
      <div className="flex justify-center">
        <CaptureBar
          phase={studio.phase}
          kind={shot.kind}
          ready={studio.camera.state === "live"}
          error={captureError(studio, errorMessage, t("recordFailed"))}
          onRecord={studio.actions.record}
          onStop={studio.actions.stop}
          onRetake={studio.actions.retake}
          onUse={studio.actions.use}
        />
      </div>
    </div>
  );
}

function Studio(props: StudioShot) {
  const { shot, videoId } = props;
  const studio = useStudio(props);
  const { tilt, ask } = useTilt(shot.camera);
  const [speak, setSpeak] = useState(true);
  const live = studio.camera.state === "live";
  const setup = studio.phase === "setup" || studio.phase === "countdown";
  const recording = studio.phase === "recording";
  const scene = useSceneGuide(studio.camera.video, {
    videoId,
    shotIndex: props.index,
    active: studio.phase === "setup" && live,
  });
  // Bodies are tracked only while getting into place: not while recording, so the phone's
  // work goes to the recorder.
  const guides = useBodyGuides(shot, studio.camera.video, live && setup);
  const step = shot.steps[activeStep(shot.steps, studio.seconds)];
  const doodles = useDoodleScene(shot, guides, {
    setup,
    scene: scene.scene,
    move: recording ? (step?.cameraMove ?? null) : null,
  });
  useDirections({
    shot,
    enabled: speak,
    scene: scene.scene,
    countdown: studio.countdown,
    step,
    recording,
    micOn: studio.micOn,
  });
  return (
    // Exactly 9:16, as big as the screen allows: the viewfinder is the frame the plan's
    // positions are fractions of (lib/view.ts).
    <div className="relative mx-auto aspect-9/16 w-[min(100vw,calc(100dvh*9/16))] overflow-hidden bg-studio">
      <Stage studio={studio} shot={shot} doodles={doodles} />
      <div className="absolute inset-x-0 top-0">
        <StudioHud
          videoId={videoId}
          shot={shot}
          index={props.index}
          count={props.count}
          speak={speak}
          onSpeak={setSpeak}
          tilt={tilt}
          onAskTilt={ask}
          recording={recording}
        />
        {setup ? (
          <div className="px-4">
            <GuideChips
              scene={shot.scene}
              sceneCheck={scene.scene}
              framing={guides.framing}
              pose={guides.state}
              poseMatched={guides.matched}
            />
          </div>
        ) : null}
      </div>
      {recording && props.audio === "original" ? (
        <OriginalAudio videoId={videoId} shot={shot} />
      ) : null}
      <Controls studio={studio} shot={shot} step={step} voice={props.audio === "voice"} />
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
      <div className="flex h-dvh items-center justify-center">
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
  // A fresh studio per shot: its camera, recorder and guidance start over.
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

/** Director's camera: one shot at a time, with its guides, then the take. */
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
