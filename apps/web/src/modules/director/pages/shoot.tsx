"use client";

import "../live.css";
import { useApiErrorMessage } from "@repo/client";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import type { MemoryNote, Shot, ShotPlan, YourVersion } from "@repo/contracts/api";
import type { LiveToolCall, LiveToolResult } from "@repo/contracts/live";
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
import { authClient } from "@/lib/auth-client";
import { DirectorGate, YouTubeEmbed } from "@/modules/shorts";
import { DirectorCaptions, DirectorOrb, useLiveFailure } from "../components/director-captions";
import { MarksLayer } from "../components/marks-layer";
import { MatchGhost } from "../components/match-ghost";
import { MemoryChips } from "../components/memory-chips";
import {
  DoneButton,
  PausedVeil,
  RecIndicator,
  RollProgress,
  SavingFootage,
  UploadNotice,
} from "../components/roll-parts";
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
import { AwayBanner, SlowerLinePill } from "../components/slower-line";
import { TakeReview } from "../components/take-review";
import { Teleprompter } from "../components/teleprompter";
import { useCamera } from "../hooks/use-camera";
import { type DirectorLive, useDirectorLive } from "../hooks/use-director-live";
import { useLeaveGuard } from "../hooks/use-leave-guard";
import { type Marks, useShotMarks } from "../hooks/use-marks";
import { useMemory } from "../hooks/use-memory";
import { type RollShoot, useRollShoot } from "../hooks/use-roll-shoot";
import { useWakeAudio, useWakeLock } from "../hooks/use-screen";
import { nextPage, type Phase, type StudioShot, shotPage, useStudio } from "../hooks/use-studio";
import { useYourVersion, type YourVersionState } from "../hooks/use-your-version";
import { type AudioMode, parseAudio } from "../lib/audio";
import { createMoveGuard, type MoveGuard } from "../lib/move-guard";
import { activeStep } from "../lib/timeline";
import {
  adaptationOf,
  adapted,
  type ChangedRow,
  films,
  forgotten,
  nextFilmed,
  ROW_FIELD,
  remembered,
  restored,
  restoredRow,
  skipped,
  yourVersion,
} from "../lib/your-version";

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
function introOf(first: boolean, roll: boolean) {
  if (roll) {
    return first ? "intro.rollFirst" : "intro.rollAgain";
  }
  return first ? "intro.first" : "intro.again";
}

/**
 * The start screen's top: ✕ back where the member came from (the short, or the editor
 * for a retake), and which short and shot this is. Before Start nothing is at stake,
 * so ✕ just goes.
 */
function StartHeader({ props, title }: { props: StudioShot; title: string }) {
  const t = useTranslations("director.shoot");
  return (
    <header className="flex items-center gap-3">
      <LeaveLink
        videoId={props.videoId}
        href={props.retake ? nextPage(props) : `/director/${props.videoId}`}
      />
      <div className="min-w-0">
        <p className="truncate text-[0.9375rem] font-semibold">{title}</p>
        <p className="text-sm text-studio-foreground/75">
          {t("shotOf", { index: props.index + 1, count: props.count })}
        </p>
      </div>
    </header>
  );
}

function StartCard({
  props,
  title,
  first,
  roll,
  sharedDemo,
  leftoverMs,
  ready,
  onStart,
}: {
  props: StudioShot;
  /** The short's title. */
  title: string;
  first: boolean;
  /** The shoot records as one roll (else take by take, on the shutter). */
  roll: boolean;
  /** The shared demo account, where takes record on the shutter: it's said up front. */
  sharedDemo: boolean;
  /** Footage an earlier visit left on this device, being sent now. */
  leftoverMs: number;
  /** Whether it's known yet if Director can join here. */
  ready: boolean;
  onStart: () => void;
}) {
  const t = useTranslations("director.shoot");
  const leftover = Math.ceil(leftoverMs / 1000);
  return (
    // The whole screen, not the 9:16 column: a phone held sideways has the width, and
    // the card scrolls rather than running off the top.
    <div className="absolute inset-0 flex flex-col gap-3 overflow-y-auto px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <StartHeader props={props} title={title} />
      <div className="mx-auto mt-auto flex w-full max-w-lg flex-col gap-3">
        <section
          aria-labelledby="shoot-intro"
          className={cn(
            "live-motion animate-[live-rise_300ms_ease-out_both] rounded-3xl p-5",
            GLASS,
          )}
        >
          <h1 id="shoot-intro" className="text-xl font-bold">
            {t("intro.title")}
          </h1>
          <p className="mt-2 text-[0.9375rem] leading-snug text-studio-foreground/85">
            {t(introOf(first, roll))}
          </p>
          {sharedDemo ? (
            <p className="mt-2 text-sm text-studio-foreground/80">{t("intro.sharedDemo")}</p>
          ) : null}
          {leftover > 0 ? (
            <p role="status" className="mt-2 text-sm text-studio-foreground/80">
              {t("roll.leftover", { seconds: leftover })}
            </p>
          ) : null}
        </section>
        <button
          type="button"
          onClick={onStart}
          disabled={!ready}
          className="h-14 shrink-0 rounded-full bg-studio-foreground text-lg font-semibold text-studio shadow-xl transition-transform active:scale-95 disabled:opacity-60"
        >
          {t("start")}
        </button>
      </div>
    </div>
  );
}

/**
 * The shared demo account (everyone trying Director without a guest of their own signs in
 * as it), as the API tells it apart: a demo user at the demo's address. The API won't
 * record its whole shoots, since they'd be everyone's to see.
 */
function useSharedDemo() {
  const system = useSystemInfoQuery();
  const { data } = authClient.useSession();
  const demo = system.data?.demo;
  return (
    demo !== null &&
    demo !== undefined &&
    data?.user.demo === true &&
    data.user.email === demo.email
  );
}

/**
 * How this screen records: as one roll with Director on, or take by take on the shutter
 * without it, where the browser can't record, or on the shared demo account. That last is
 * known before Start, so the start card says what will really happen.
 */
function useRecordingMode() {
  const system = useSystemInfoQuery();
  const liveOn = system.data?.features.live === true;
  const sharedDemo = useSharedDemo();
  const canRoll = liveOn && typeof MediaRecorder !== "undefined";
  return {
    liveOn,
    rollOn: canRoll && !sharedDemo,
    /** The roll would be on, but not on this account: the start card says why. */
    demoNoRoll: canRoll && sharedDemo,
  };
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

/**
 * Under the indicator, whenever Director is on the slower line: the pill with Reconnect,
 * or, while Gemini is out of reach, the banner that says so. Filming goes on either way.
 */
function SlowerLine({ live }: { live: DirectorLive }) {
  if (live.line !== "slower" || live.state !== "live") {
    return null;
  }
  return live.away ? <AwayBanner live={live} /> : <SlowerLinePill live={live} />;
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
      className={cn(
        "flex items-center gap-1 rounded-full py-1 pr-1 pl-4 focus-within:outline-2 focus-within:outline-studio-foreground",
        GLASS,
      )}
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label={t("label")}
        placeholder={here ? t("placeholder") : t("away")}
        disabled={!here}
        maxLength={2000}
        enterKeyHint="send"
        className="min-h-11 min-w-0 flex-1 bg-transparent text-base placeholder:text-studio-foreground/60 focus:outline-none disabled:opacity-60"
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
  roll,
  onFlip,
}: {
  shot: Shot;
  studio: Studio;
  camera: Camera;
  roll: RollShoot;
  onFlip: () => void;
}) {
  const t = useTranslations("director.shoot.shutter");
  const mode = shutterMode(studio.phase, shot);
  const live = camera.state === "live";
  return (
    <div className="flex items-center justify-between px-6">
      <FlipButton onFlip={onFlip} disabled={!live || studio.phase !== "setup"} />
      {roll.rolling ? (
        // The roll records everything: Done takes the shutter's place.
        <DoneButton
          onDone={roll.done}
          disabled={roll.phase !== "recording" && roll.phase !== "paused"}
        />
      ) : (
        <Shutter
          mode={mode}
          label={t(mode)}
          progress={studio.seconds / shot.durationSeconds}
          disabled={!live}
          onClick={studio.actions.shutter}
        />
      )}
      <span aria-hidden className="size-12" />
    </div>
  );
}

/**
 * What the roll's upload needs the member to know while it records: footage dropped for
 * good and why (REC would otherwise keep ticking over nothing), footage waiting for a
 * connection, and the shoot's 20 minutes nearly up.
 */
function RollUpload({ roll }: { roll: RollShoot }) {
  const errorMessage = useApiErrorMessage();
  const { upload } = roll;
  return (
    <UploadNotice
      lost={upload.lost === null ? null : errorMessage(upload.lost)}
      waiting={upload.error !== null || upload.full}
      nearLimit={roll.nearLimit}
    />
  );
}

/**
 * The top band's left: the roll's indicator, or the shot's progress. The roll's progress
 * strip has a row of its own under it: next to ✕ it would push ✕ off a phone's screen.
 */
function TopLeft({ props, studio, roll }: Pick<Screen, "props" | "studio" | "roll">) {
  if (roll.rolling) {
    return (
      <RecIndicator
        elapsedMs={roll.elapsedMs}
        paused={roll.phase === "paused"}
        onPause={roll.pause}
        onResume={roll.resume}
      />
    );
  }
  if (studio.phase === "recording") {
    return <RecordingPill seconds={studio.seconds} />;
  }
  return <ShotProgress index={props.index} count={props.count} />;
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
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-[0.9375rem] font-semibold empty:hidden",
            GLASS,
          )}
        >
          {step?.instruction}
        </p>
      )}
    </div>
  );
}

interface Screen {
  props: StudioShot;
  /** The card's rows Director changed for the member. */
  changed: ReadonlySet<ChangedRow>;
  /** What Director remembers, as chips; × forgets one. */
  notes: readonly MemoryNote[];
  onForget: (note: MemoryNote) => void;
  /** ↺ on a changed row of the card. */
  onRestore: (row: ChangedRow) => void;
  studio: Studio;
  camera: Camera;
  live: DirectorLive;
  liveOn: boolean;
  roll: RollShoot;
  onFlip: () => void;
  onLeave: (event: { preventDefault: () => void }) => void;
}

/** Everything over the picture once the shoot has started, in a top and a bottom band. */
function Overlay(screen: Screen) {
  const { props, changed, studio, camera, live, liveOn, roll, onFlip, onLeave } = screen;
  const t = useTranslations("director.shoot");
  const { shot, index, videoId, audio } = props;
  const recording = studio.phase === "recording";
  const setup = studio.phase === "setup";
  return (
    <>
      <div className="absolute inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <TopLeft props={props} studio={studio} roll={roll} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DirectorPill live={live} />
            <LeaveLink videoId={videoId} onClick={onLeave} />
          </div>
        </div>
        {roll.rolling ? (
          <RollProgress index={props.index} states={roll.states} onGo={roll.go} />
        ) : null}
        <SlowerLine live={live} />
        {roll.rolling ? <RollUpload roll={roll} /> : null}
        {setup ? (
          <ShotCard shot={shot} index={index} changed={changed} onRestore={screen.onRestore} />
        ) : null}
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
        {setup ? <MemoryChips notes={screen.notes} onForget={screen.onForget} /> : null}
        {setup && liveOn ? <TellBox live={live} /> : null}
        <Controls shot={shot} studio={studio} camera={camera} roll={roll} onFlip={onFlip} />
      </div>
    </>
  );
}

type ToolHandler = (id: string, call: LiveToolCall) => void;

interface ToolScreen extends Pick<Screen, "props" | "studio" | "camera" | "live"> {
  /** The member's version: Director's changes go on it. */
  yours: YourVersionState;
  marks: Marks;
  /** Director's mark on the roll: what came of it. */
  mark: (call: Extract<LiveToolCall, { name: "mark" }>) => Promise<LiveToolResult>;
  /** Whether Director may move the member to another shot just now (lib/move-guard.ts). */
  guard: MoveGuard;
  /** Whether the shoot is recording as a roll, which only the member's Done ends. */
  rolling: () => boolean;
}

type Go = (href: ReturnType<typeof nextPage>) => void;

/**
 * Where the member goes after shot `index` in their version: the next shot they film,
 * or the editor once none is left (skipped shots and gaps aren't filmed).
 */
function pageAfter(props: StudioShot, version: YourVersion) {
  if (props.retake) {
    return nextPage(props);
  }
  const next = nextFilmed(version, props.index, props.count);
  return nextPage({ ...props, index: next === null ? props.count - 1 : next - 1 });
}

/**
 * Director left a shot out: if it's this one, the screen moves on past it, once the
 * member has asked to (lib/move-guard.ts). While a roll records, the last shot left out
 * never takes them to the editor: only their own Done ends the roll.
 */
function skip(index: number, { props, yours, guard, rolling }: ToolScreen, go: Go): LiveToolResult {
  const current = index === props.index;
  if (current && !guard.allows()) {
    return "not_asked";
  }
  const version = yours.change((now) => skipped(now, index));
  const lastOne = nextFilmed(version, props.index, props.count) === null;
  if (current && !(lastOne && rolling())) {
    go(pageAfter(props, version));
  }
  return "done";
}

/**
 * Director moves the member to another shot: not to one their version leaves out, and,
 * just after it changed their plan, only once they've asked (lib/move-guard.ts).
 */
function goTo(shot: number, { props, yours, guard }: ToolScreen, go: Go): LiveToolResult {
  if (shot === props.index) {
    return "done";
  }
  if (!films(yours.current(), shot)) {
    return "not_filmed";
  }
  if (!guard.allows()) {
    return "not_asked";
  }
  go(shotPage(props.videoId, shot, props.audio, props.retake));
  return "done";
}

/** The tools that change the member's version: shown at once, kept, and Director told. */
function versionResult(
  call: Extract<LiveToolCall, { name: "adapt_shot" | "restore_shot" | "remember" | "forget" }>,
  { yours }: ToolScreen,
): LiveToolResult {
  switch (call.name) {
    case "adapt_shot": {
      const { name: _, ...change } = call;
      yours.change((now) => adapted(now, change));
      return "done";
    }
    case "restore_shot":
      yours.change((now) => restored(now, call.shot));
      return "done";
    case "remember":
      yours.change((now) => remembered(now, { kind: call.kind, note: call.note }));
      return "done";
    case "forget":
      yours.change((now) => forgotten(now, call.note));
      return "done";
  }
}

/** What each of Director's tools does on screen, and what came of it. */
function toolResult(
  call: Exclude<LiveToolCall, { name: "point_at" | "mark" }>,
  screen: ToolScreen,
  go: Go,
): LiveToolResult | Promise<LiveToolResult> {
  const { camera } = screen;
  switch (call.name) {
    case "go_to_shot":
      return goTo(call.shot, screen, go);
    case "switch_camera":
      if (camera.state !== "live") {
        return "no_camera";
      }
      camera.face(call.to);
      return "done";
    case "skip_shot":
      return skip(call.shot, screen, go);
    case "replan":
      return replan(call.instruction, screen);
    default: {
      const result = versionResult(call, screen);
      if (call.name === "adapt_shot" || call.name === "remember") {
        screen.guard.planChanged();
      }
      return result;
    }
  }
}

/**
 * Director re-plans what's left. It can't speak while it waits (a re-plan takes a few
 * seconds, sometimes many), so the member reads that it's on it meanwhile.
 */
async function replan(instruction: string, { yours, live, guard }: ToolScreen) {
  live.working("replanning");
  try {
    await yours.replan(instruction);
    guard.planChanged();
    return "done";
  } catch {
    return "failed";
  } finally {
    live.working(null);
  }
}

/**
 * Director's tool calls, done the way the member's own taps are, and answered with what
 * really happened: nothing changes the shot, the card or the camera while a take is
 * under way.
 */
function useTools(tools: { current: ToolHandler }, screen: ToolScreen) {
  const router = useRouter();
  useLayoutEffect(() => {
    tools.current = (id, call) => {
      if (call.name === "mark") {
        void screen.mark(call).then((result) => screen.live.answer(id, result));
        return;
      }
      if (screen.studio.phase !== "setup") {
        return screen.live.answer(id, "busy");
      }
      // A mark looks at the picture first: Director hears once it's drawn, or not.
      if (call.name === "point_at") {
        const { live, marks } = screen;
        void marks.point(id, call.target, call.label).then((result) => live.answer(id, result));
        return;
      }
      const answer = toolResult(call, screen, (href) => router.push(href));
      void Promise.resolve(answer).then((result) => screen.live.answer(id, result));
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

/** The chip's × and the card's ↺: the member's own changes to their version, told to Director. */
function versionTaps(yours: YourVersionState, live: DirectorLive, index: number) {
  return {
    notes: yours.version.notes,
    onForget: (note: MemoryNote) => {
      yours.change((now) => forgotten(now, note.note));
      live.forgot(note);
    },
    onRestore: (row: ChangedRow) => {
      yours.change((now) => restoredRow(now, index, ROW_FIELD[row]));
      live.restored(index, ROW_FIELD[row]);
    },
  };
}

/**
 * The member's version of the plan, and of the shot on screen; Director live hears each
 * new version as it lands, through `shared` (set once Director live exists).
 */
function useShotVersion(videoId: string, plan: ShotPlan, index: number) {
  const shared = useRef<(next: YourVersion) => void>(() => undefined);
  const yours = useYourVersion(videoId, (next) => shared.current(next));
  const shot = required(plan.shots[index], "the shot");
  return { shared, yours, version: yourVersion(shot, adaptationOf(yours.version, index)) };
}

/**
 * Director's voice would talk over the 3-2-1 and end up in the take: it's held (dropped,
 * and not captioned) from the first number to the take's end. Set before the screen
 * paints, so nothing Director says once the review shows is dropped as if mid-take.
 */
function useQuietTakes(live: DirectorLive, studio: Studio) {
  const { hold } = live;
  const quiet = studio.phase === "countdown" || studio.phase === "recording";
  useLayoutEffect(() => hold(quiet), [hold, quiet]);
}

/**
 * Director live for the shoot, with what its tool calls reach: the roll's marks and
 * whether it records (both set up by the screen with the roll), and the guard on moving
 * the member to another shot, which hears their words.
 */
function useShootLive(videoId: string, index: number, camera: Camera, yours: YourVersionState) {
  const tools = useRef<ToolHandler>(() => undefined);
  const mark = useRef<ToolScreen["mark"]>(() => Promise.resolve("not_recording"));
  const rolling = useRef<() => boolean>(() => false);
  const [moves] = useState(() => createMoveGuard(() => performance.now()));
  const live = useDirectorLive({
    videoId,
    shotIndex: index,
    video: camera.video,
    onTool: (id, call) => tools.current(id, call),
    version: yours.version,
    onMemberSaid: moves.memberSaid,
  });
  return { live, tools, mark, rolling, moves };
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
  const { shared, yours, version } = useShotVersion(videoId, plan, index);
  const props: StudioShot = {
    videoId,
    shot: version.shot,
    index,
    count: plan.shots.length,
    audio,
    retake,
  };
  const { live, tools, mark, rolling, moves } = useShootLive(videoId, index, camera, yours);
  useLayoutEffect(() => {
    shared.current = live.share;
  });
  const studio = useStudio(props, camera, {
    onCountdown: () => live.take("countdown"),
    onCancelled: () => live.take("cancelled"),
    onRecording: () => live.take("recording"),
    onRecorded: () => live.take("recorded"),
    onDiscarded: () => live.take("discarded"),
    onKept: () => guard.current.go(pageAfter(props, yours.version)),
  });
  const marks = useShotMarks({
    video: camera.video,
    facing: camera.facing,
    shot: index,
    setup: studio.phase === "setup",
  });
  useTools(tools, {
    props,
    studio,
    camera,
    live,
    yours,
    marks,
    mark: (call) => mark.current(call),
    guard: moves,
    rolling: () => rolling.current(),
  });
  const onFlip = useMemberFlip(camera, live);
  useQuietTakes(live, studio);
  useWakeLock();
  useWakeAudio();
  const taps = versionTaps(yours, live, index);
  return {
    props,
    changed: version.changed,
    taps,
    camera,
    live,
    studio,
    onFlip,
    guard,
    marks,
    mark,
    rolling,
  };
}

/** The camera's picture, full bleed, mirrored for the front camera as a mirror would be. */
function CameraPicture({ camera }: { camera: Camera }) {
  return (
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
  );
}

/**
 * Leaving the shoot without losing anything by accident: ✕ and back ask first while a
 * countdown, a take or the roll is on. Leaving mid-roll ends the session there, its
 * footage kept for the editor.
 */
function useShootLeaving(shoot: ReturnType<typeof useShoot>, roll: RollShoot) {
  const rolling = roll.phase === "recording" || roll.phase === "paused";
  const leaving = useLeaveGuard({
    guarded: shoot.studio.phase !== "setup" || rolling,
    away: `/director/${shoot.props.videoId}`,
    halt: shoot.studio.actions.halt,
  });
  useLayoutEffect(() => {
    shoot.guard.current = leaving;
  });
  return { ...leaving, rolling };
}

/** "Leave? This take isn't kept yet." (or, mid-roll, that it ends the shoot), with Leave and Stay. */
function LeaveDialog({ leaving }: { leaving: ReturnType<typeof useShootLeaving> }) {
  const t = useTranslations("director.shoot.leaving");
  // Focus starts on Stay, so Enter on a laptop never leaves by accident.
  const stay = useRef<HTMLButtonElement>(null);
  return (
    // Only ever closed from inside (Stay, Escape, a tap outside): each of those means stay.
    <AlertDialog open={leaving.asking} onOpenChange={() => leaving.stay()}>
      <AlertDialogContent initialFocus={stay}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {leaving.rolling ? t("rollBody") : t("body")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={stay}>{t("stay")}</AlertDialogCancel>
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
  const { liveOn, rollOn, demoNoRoll } = useRecordingMode();
  const memory = useMemory();
  const [started, setStarted] = useState(false);
  const shoot = useShoot(shootProps);
  const { camera, live, studio } = shoot;
  const roll = useRollShoot({ props: shoot.props, camera, live, wanted: started && rollOn });
  useLayoutEffect(() => {
    shoot.mark.current = roll.mark;
    shoot.rolling.current = () => roll.rolling;
  });
  const leaving = useShootLeaving(shoot, roll);
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
        <CameraPicture camera={camera} />
        {started && !blocked ? (
          <MarksLayer
            marks={shoot.marks.marks}
            video={camera.video}
            mirrored={camera.facing === "front"}
          />
        ) : null}
        {started ? <MatchGhost {...shootProps} facing={camera.facing} /> : null}
        {roll.phase === "paused" ? <PausedVeil onResume={roll.resume} /> : null}
        {started && !blocked && !reviewing ? (
          <Overlay
            props={shoot.props}
            changed={shoot.changed}
            {...shoot.taps}
            studio={studio}
            camera={camera}
            live={live}
            liveOn={liveOn}
            roll={roll}
            onFlip={shoot.onFlip}
            onLeave={leaving.leave}
          />
        ) : null}
        {roll.phase === "finishing" || roll.phase === "done" ? (
          <SavingFootage
            behindMs={roll.upload.behindMs}
            waiting={roll.upload.error !== null}
            editor={roll.editor}
          />
        ) : null}
        <Review shoot={shoot} />
        <LeaveDialog leaving={leaving} />
        {blocked ? <CameraBlocked camera={camera} /> : null}
      </div>
      {started ? null : (
        <StartCard
          props={shoot.props}
          title={shootProps.plan.title}
          first={memory.before.sessions === 0}
          roll={rollOn}
          sharedDemo={demoNoRoll}
          leftoverMs={roll.upload.behindMs}
          ready={system.data !== undefined}
          onStart={start}
        />
      )}
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
