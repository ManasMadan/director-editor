"use client";

import { useDirectorTakesQuery } from "@repo/client/api/director/takes";
import type { CameraMove, SceneCheck, Shot } from "@repo/contracts/api";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Perception } from "../lib/cues";
import { type Cut, directorsCut, type Setup } from "../lib/cut";
import type { DoodleScene } from "../lib/doodle";
import { intentOf, type Vocabulary } from "../lib/intents";
import { type Countdown, countdownOf } from "../lib/memory";
import { isReady, readinessOf } from "../lib/readiness";
import { grounded, thingFor } from "../lib/things";
import { tiltHint, tiltInRange, tiltOffset } from "../lib/tilt";
import { activeStep } from "../lib/timeline";
import { useBodyGuides } from "./use-body-guides";
import { useListening } from "./use-listening";
import { useLiveDirector } from "./use-live-director";
import { useMemory } from "./use-memory";
import { useSceneGuide } from "./use-scene-guide";
import { buzz, useIdle, useWakeLock } from "./use-screen";
import { useStickers } from "./use-stickers";
import { type StudioShot, useStudio } from "./use-studio";
import { useThings } from "./use-things";
import { useTilt } from "./use-tilt";
import { useVision } from "./use-vision";

type Studio = ReturnType<typeof useStudio>;

/** Everything Director perceives on set, on the device and from Gemini, while it's watching. */
function usePerceiving(props: StudioShot, studio: Studio, paused: boolean) {
  const { shot, videoId, index } = props;
  const { camera, phase } = studio;
  const live = camera.state === "live";
  const sharing = camera.source === "screen";
  const setup = phase === "setup";
  const watching = live && !paused;
  const { tilt, ask } = useTilt(camera.facing);
  const vision = useVision(camera.video, camera.stream, {
    active: live && (setup || phase === "countdown" || phase === "recording"),
    recording: phase === "recording",
  });
  const scene = useSceneGuide(camera.video, {
    videoId,
    shotIndex: index,
    active: setup && watching && !sharing,
    moved: vision.moved,
  });
  const guides = useBodyGuides(shot, camera.video, {
    // Bodies are tracked only while getting into place: while recording, the phone's
    // work goes to the recorder.
    live: watching && !sharing && (setup || phase === "countdown"),
    camera: camera.facing,
    onRaise: studio.actions.record,
  });
  const things = useThings(camera.video, {
    enabled: setup && watching,
    landmark: shot.sceneLandmark,
  });
  const level = tilt ? tiltInRange(tilt, shot.phoneAngle) : null;
  const readiness = readinessOf({
    landmark: shot.sceneLandmark,
    scene: scene.scene,
    offline: scene.offline,
    framing: guides.framing,
    level,
    light: vision.light,
  });
  return { tilt, ask, level, vision, scene, guides, things, readiness, ready: isReady(readiness) };
}

type Perceiving = ReturnType<typeof usePerceiving>;

function perceptionOf(
  shot: Shot,
  studio: Studio,
  seen: Perceiving,
  { paused, countdownFrom }: { paused: boolean; countdownFrom: number },
): Perception {
  const recording = studio.phase === "recording";
  const stepIndex = activeStep(shot.steps, studio.seconds);
  const step = shot.steps[stepIndex];
  return {
    phase: studio.phase,
    paused,
    sharing: studio.camera.source === "screen",
    micRecording: recording && studio.micOn,
    countdown: studio.countdown,
    countdownFrom,
    scene: seen.scene.scene,
    offline: seen.scene.offline,
    light: seen.vision.light,
    framing: seen.guides.framing,
    angle:
      seen.tilt && seen.level === false ? tiltHint(tiltOffset(seen.tilt, shot.phoneAngle)) : null,
    posed: seen.guides.tracksBody && seen.guides.state === "ready" ? seen.guides.matched : null,
    ready: seen.ready,
    things: seen.things,
    step: recording && step ? { index: stepIndex, instruction: step.instruction } : null,
    ideas: [shot.purpose, shot.framing.note, shot.pose.description].filter(Boolean),
  };
}

/** The horizon to level, while setting up on a phone (one with a tilt sensor). */
function horizonOf(shot: Shot, seen: Perceiving, show: boolean): DoodleScene["horizon"] {
  if (!(show && seen.tilt)) {
    return null;
  }
  return { roll: -tiltOffset(seen.tilt, shot.phoneAngle).roll, level: seen.level === true };
}

const prefersStill = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The words on the doodles: the spot, how far to walk, the camera move. */
function labelsOf(
  t: ReturnType<typeof useTranslations<"director.shoot.doodle">>,
  check: SceneCheck | null,
  move: CameraMove | null,
): DoodleScene["labels"] {
  const meters = check && !check.inPlace ? check.distanceMeters : null;
  return {
    spot: t("standHere"),
    meters: meters === null ? null : t("meters", { meters }),
    move: move === null || move === "static" ? null : t(`move.${move}`),
  };
}

/** What the doodles show now: getting into place until recording starts, then the moves. */
function useDoodleScene(
  shot: Shot,
  studio: Studio,
  seen: Perceiving,
  { stickers, paused }: { stickers: DoodleScene["stickers"]; paused: boolean },
): DoodleScene {
  const t = useTranslations("director.shoot.doodle");
  const live = useTranslations("director.live");
  const setup = studio.phase === "setup" || studio.phase === "countdown";
  const recording = studio.phase === "recording";
  const sharing = studio.camera.source === "screen";
  // The walk is done once the countdown starts: the frame clears for the number. The
  // landmark is drawn where the phone sees it when its detector knows it.
  const check =
    studio.phase === "setup" && !sharing
      ? grounded(seen.scene.scene, seen.things, shot.sceneLandmark)
      : null;
  const landmark = thingFor(shot.sceneLandmark);
  const step = shot.steps[activeStep(shot.steps, studio.seconds)];
  const move = recording && step ? step.cameraMove : null;
  return {
    shot,
    target: sharing ? {} : seen.guides.target,
    matched: seen.guides.matched,
    mirrored: studio.camera.facing === "front" && !sharing,
    person: seen.guides.person,
    framing: setup ? seen.guides.framing : null,
    scene: check,
    move,
    recording,
    subject: !sharing,
    // Paused, the frame holds still too.
    still: paused || prefersStill(),
    horizon: horizonOf(shot, seen, setup && !sharing),
    // The landmark has its own lasso; everything else worth using gets a highlight.
    highlights: (studio.phase === "setup" ? seen.things : [])
      .filter((thing) => thing.thing !== landmark)
      .map((thing) => ({
        key: thing.thing,
        label: live(`thing.${thing.thing}`),
        box: thing.box,
      })),
    stickers,
    labels: labelsOf(t, check, move),
  };
}

/** Which take of this shot the next one is: the ones already sent, then this visit's. */
function useTakeNumber(videoId: string, shotIndex: number, attempts: number) {
  const takes = useDirectorTakesQuery(videoId);
  const sent = (takes.data ?? []).filter((take) => take.shotIndex === shotIndex).length;
  return sent + Math.max(1, attempts);
}

/** Director's ears: what the member says, as requests to act on. */
function useVoice(
  session: { studio: Studio; listen: boolean; paused: boolean },
  act: Record<
    "action" | "cut" | "again" | "keep" | "flip" | "repeat" | "quiet" | "talk",
    () => void
  >,
  interrupt: () => void,
) {
  const locale = useLocale();
  const words = useTranslations("director.live.voice.words");
  const vocabulary: Vocabulary = useMemo(
    () => ({
      action: words("action"),
      cut: words("cut"),
      again: words("again"),
      keep: words("keep"),
      flip: words("flip"),
      repeat: words("repeat"),
      help: words("help"),
      quiet: words("quiet"),
      talk: words("talk"),
    }),
    [words],
  );
  const { studio, listen } = session;
  // A take recording the member's voice is theirs alone: Director stops listening for it.
  const enabled =
    listen && studio.camera.state === "live" && !(studio.phase === "recording" && studio.micOn);
  return useListening(enabled, locale, {
    onInterrupt: interrupt,
    onPhrase: (text) => {
      const intent = intentOf(text, vocabulary);
      if (intent) {
        (intent === "help" ? act.repeat : act[intent])();
      }
    },
  });
}

/** The latest value, for effects that run on one change but read the rest as they are. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

type SetupAtStart = Pick<Setup, "framed" | "angled" | "posed">;

/**
 * The Director's Cut of each take, worked out the moment it's recorded from what the
 * phone measured (lib/cut.ts) and how the setup stood when the countdown began.
 */
function useTakeReview(shot: Shot, studio: Studio, seen: Perceiving) {
  const [cut, setCut] = useState<Cut | null>(null);
  const latest = useLatest(seen);
  const setup = useRef<SetupAtStart>({ framed: null, angled: null, posed: null });
  const { phase, take } = studio;
  useEffect(() => {
    const now = latest.current;
    if (phase === "countdown") {
      setup.current = {
        framed: now.guides.framing === null ? null : now.guides.framing === "in-frame",
        angled: now.level,
        posed: now.guides.tracksBody ? now.guides.matched : null,
      };
    }
    if (phase === "setup") {
      setCut(null);
    }
  }, [phase, latest]);
  useEffect(() => {
    if (phase === "preview" && take) {
      const length = shot.durationSeconds;
      setCut(
        directorsCut(latest.current.vision.take(), { kind: shot.kind, length, ...setup.current }),
      );
    }
  }, [phase, take, shot, latest]);
  return cut;
}

interface Calls {
  studio: Studio;
  seen: Perceiving;
  cut: Cut | null;
  take: number;
  announce: (text: string) => void;
  add: ReturnType<typeof useStickers>["add"];
}

/**
 * The set's rhythm, called and stuck on the frame as it happens: the slate as a take
 * rolls, "Cut!" as it ends, the Director's Cut said aloud a beat later, a sticker when
 * the shot comes together, a star when the pose locks.
 */
function useSetCalls({ studio, seen, cut, take, announce, add }: Calls) {
  const t = useTranslations("director.live");
  const latest = useLatest({ take, announce, add, kind: studio.micOn });
  const { phase } = studio;
  const previous = useRef(phase);
  useEffect(() => {
    const before = previous.current;
    previous.current = phase;
    const now = latest.current;
    if (phase === "countdown") {
      buzz(15);
    }
    if (phase === "recording") {
      now.add("clap", { x: 0.5, y: 0.3 }, t("sticker.take", { take: now.take }));
      buzz(40);
    }
    if (before === "recording" && phase === "preview") {
      now.announce(t("say.cut"));
      now.add("cut", { x: 0.5, y: 0.42 }, t("sticker.cut"));
      buzz([30, 60, 30]);
    }
  }, [phase, latest, t]);
  // The review a beat after "Cut!", so the two don't talk over each other.
  useEffect(() => {
    if (!cut) {
      return;
    }
    const timer = window.setTimeout(() => {
      const praise = t(`cut.praise.${cut.praise}`);
      latest.current.announce(`${praise} ${cut.tip ? t(`cut.tip.${cut.tip}`) : t("cut.ship")}`);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [cut, latest, t]);
  const ready = seen.ready && phase === "setup";
  useEffect(() => {
    if (ready) {
      latest.current.add("nailed", { x: 0.5, y: 0.4 }, t("sticker.nailed"));
      buzz([20, 40, 20]);
    }
  }, [ready, latest, t]);
  const matched = seen.guides.matched && phase === "setup";
  const head = seen.guides.target.nose;
  useEffect(() => {
    if (matched && head) {
      latest.current.add("star", { x: head.x, y: Math.max(0.08, head.y - 0.08) });
    }
  }, [matched, head, latest]);
}

/** What the member can do, each also remembered or announced as a director would. */
function sessionActions({
  studio,
  seen,
  cut,
  director,
  remember,
  setAttempts,
  setPaused,
  t,
}: {
  studio: Studio;
  seen: Perceiving;
  cut: Cut | null;
  director: ReturnType<typeof useLiveDirector>;
  remember: ReturnType<typeof useMemory>["record"];
  setAttempts: (update: (now: number) => number) => void;
  setPaused: (paused: boolean) => void;
  t: ReturnType<typeof useTranslations<"director.live">>;
}) {
  return {
    ...studio.actions,
    // A shared screen is for showing Director, not for filming.
    record: () => {
      if (studio.camera.source === "camera") {
        studio.actions.record();
      }
    },
    retake: () => {
      remember({ type: "retake", lateStart: cut?.lateStart ?? false });
      setAttempts((now) => Math.max(1, now) + 1);
      director.announce(t("say.backToOne"));
      studio.actions.retake();
    },
    use: () => {
      remember({
        type: "kept",
        score: cut?.score ?? 0,
        lateStart: cut?.lateStart ?? false,
        light: seen.vision.light,
        things: seen.things.map((thing) => thing.thing),
      });
      studio.actions.use();
    },
    speak: (on: boolean) => remember({ type: "prefer", speak: on }),
    listen: (on: boolean) => remember({ type: "prefer", listen: on }),
    countdown: (seconds: Countdown | null) => remember({ type: "prefer", countdown: seconds }),
    pause: setPaused,
  };
}

/**
 * One shot's session with Director: the studio (camera, countdown, recorder, sending),
 * what Director perceives, what it says and draws, what it hears, what it remembers, and
 * the Director's Cut of each take.
 */
export function useSession(props: StudioShot) {
  const t = useTranslations("director.live");
  const { shot, videoId, index } = props;
  const { before, memory, record: remember } = useMemory();
  const countdownFrom = countdownOf(memory);
  const studio = useStudio(props, countdownFrom);
  const [paused, setPaused] = useState(false);
  const seen = usePerceiving(props, studio, paused);
  const { stickers, add } = useStickers();
  const perception = perceptionOf(shot, studio, seen, { paused, countdownFrom });
  const director = useLiveDirector({
    perception,
    speak: memory.speak,
    memory: before,
    shot,
    index,
  });
  const [attempts, setAttempts] = useState(0);
  const take = useTakeNumber(videoId, index, attempts);
  const cut = useTakeReview(shot, studio, seen);
  useSetCalls({ studio, seen, cut, take, announce: director.announce, add });
  useEffect(() => remember({ type: "opened" }), [remember]);
  useWakeLock();

  const actions = sessionActions({
    studio,
    seen,
    cut,
    director,
    remember,
    setAttempts,
    setPaused,
    t,
  });
  const voice = useVoice(
    { studio, listen: memory.listen, paused },
    {
      action: () => studio.phase === "setup" && actions.record(),
      cut: () => studio.phase === "recording" && studio.actions.stop(),
      again: () => studio.phase === "preview" && actions.retake(),
      keep: () => studio.phase === "preview" && actions.use(),
      // Flipping reopens the camera: never while the member is showing a screen.
      flip: () => studio.camera.source === "camera" && studio.camera.flip(),
      repeat: director.repeat,
      quiet: () => actions.speak(false),
      talk: () => {
        actions.speak(true);
        setPaused(false);
      },
    },
    director.interrupt,
  );
  const scene = useDoodleScene(shot, studio, seen, { stickers, paused });
  const idle = useIdle(studio.phase === "setup" || studio.phase === "recording");
  return {
    studio,
    seen,
    director,
    voice,
    memory,
    countdownFrom,
    paused,
    take,
    cut,
    scene,
    idle,
    actions,
  };
}
