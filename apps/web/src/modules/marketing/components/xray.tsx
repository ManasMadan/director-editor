import type { CameraMove, FrameBox, Shot } from "@repo/contracts/api";
import { cn } from "@repo/ui/lib/utils";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  Lock,
  type LucideIcon,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { type JsonLine, jsonLines } from "../lib/plan-json";
import { XRAY } from "../lib/seed-excerpt";
import { thumbnailUrl } from "../lib/youtube";

/*
 * The x-ray: a real seed's plan, as Gemini wrote it, taking its Short apart. Positions in
 * a plan are fractions of a 9:16 frame, so every overlay draws in a 90 x 160 viewBox over
 * a 9:16 box: a unit is the same length both ways and nothing stretches.
 */
const FRAME_WIDTH = 90;
const FRAME_HEIGHT = 160;
const VIEW_BOX = `0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}`;

/** When each part of the x-ray arrives, in seconds from load (landing.css plays them). */
const AT = {
  framing: 1.5,
  sizeNote: 1.9,
  pose: 2.1,
  script: 2.7,
  phoneAngle: 3,
  ready: 3.3,
  shots: 3.5,
} as const;
const delay = (seconds: number) => ({ animationDelay: `${seconds}s` });

/** The fields of a shot the panel prints that the phone draws, and when it draws each. */
const DRAWN_AT: Partial<Record<string, number>> = {
  framing: AT.framing,
  pose: AT.pose,
  script: AT.script,
  phoneAngle: AT.phoneAngle,
};

/** The body's lines between the joints a plan can name (the nose is the head's centre). */
const BONES = [
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
] as const;

const MOVE_ICONS: Record<CameraMove, LucideIcon> = {
  static: Lock,
  up: ArrowUp,
  down: ArrowDown,
  left: ArrowLeft,
  right: ArrowRight,
  forward: ZoomIn,
  back: ZoomOut,
  orbit: RotateCw,
  "tilt-up": ChevronsUp,
  "tilt-down": ChevronsDown,
};

/** The move a shot is known by: its first that isn't holding still. */
const moveOf = (shot: Shot): CameraMove =>
  shot.steps.find((step) => step.cameraMove !== "static")?.cameraMove ?? "static";

const inFrame = (frame: FrameBox) => ({
  x: frame.x * FRAME_WIDTH,
  y: frame.y * FRAME_HEIGHT,
  width: frame.width * FRAME_WIDTH,
  height: frame.height * FRAME_HEIGHT,
});

/** The pose to match, drawn as a figure over the frame. */
function PoseFigure({ pose }: { pose: Shot["pose"] }) {
  const joints = new Map(
    pose.keypoints.map(({ name, x, y }) => [name, { x: x * FRAME_WIDTH, y: y * FRAME_HEIGHT }]),
  );
  const head = joints.get("nose");
  const bones = BONES.flatMap(([from, to]) => {
    const a = joints.get(from);
    const b = joints.get(to);
    return a && b ? [{ id: `${from}-${to}`, a, b }] : [];
  });
  return (
    <g className="text-studio-foreground" fill="none" stroke="currentColor" strokeWidth={1}>
      {bones.map(({ id, a, b }) => (
        <line
          key={id}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          pathLength={1}
          strokeLinecap="round"
          className="xray-draw"
          style={delay(AT.pose)}
        />
      ))}
      {head ? (
        <circle
          cx={head.x}
          cy={head.y}
          r={7}
          pathLength={1}
          className="xray-draw"
          style={delay(AT.pose)}
        />
      ) : null}
      {pose.keypoints.map(({ name, x, y }) => (
        <circle
          key={name}
          cx={x * FRAME_WIDTH}
          cy={y * FRAME_HEIGHT}
          r={1.6}
          stroke="none"
          className="xray-in fill-current"
          style={delay(AT.pose + 0.4)}
        />
      ))}
    </g>
  );
}

/** The director's notes stuck on the frame: the shot size and where to hold the phone. */
async function Notes({ shot }: { shot: Shot }) {
  const director = await getTranslations("director");
  const { x, y } = shot.framing.subject;
  const sticker =
    "xray-note xray-in absolute rounded-sm bg-doodle-pop px-1.5 text-sm leading-snug text-studio";
  return (
    <>
      <p
        className={cn(sticker, "-rotate-3")}
        style={{ ...delay(AT.sizeNote), left: `${x * 100}%`, top: `${Math.max(y * 100 - 4, 2)}%` }}
      >
        {director(`live.size.${shot.framing.shotSize}`)}
      </p>
      <p
        className={cn(sticker, "right-2 bottom-28 max-w-[70%] rotate-2")}
        style={delay(AT.phoneAngle)}
      >
        {director(`shoot.height.${shot.phoneAngle.height}`)}
      </p>
    </>
  );
}

/** The phone: the Short's frame, the plan's guides drawn over it, then ready to film. */
export async function Phone({ shot, shots }: { shot: Shot; shots: number }) {
  const [t, director] = await Promise.all([getTranslations("home"), getTranslations("director")]);
  const [line] = shot.script;
  return (
    <div className="relative mx-auto aspect-9/16 w-full max-w-56 overflow-hidden rounded-[1.75rem] border-4 border-studio-foreground/15 bg-studio shadow-2xl sm:max-w-none">
      <Image
        src={thumbnailUrl(XRAY.videoId, "sddefault")}
        alt=""
        fill
        unoptimized
        fetchPriority="high"
        loading="eager"
        sizes="14rem"
        className="object-cover"
      />
      <div className="absolute inset-0 bg-studio/35" />
      <div className="xray-scan absolute inset-0 bg-linear-to-b from-transparent via-transparent via-70% to-aurora-2/70" />
      <svg aria-hidden viewBox={VIEW_BOX} className="absolute inset-0 size-full">
        <rect
          {...inFrame(shot.framing.subject)}
          rx={3}
          pathLength={1}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.2}
          className="xray-draw text-guide"
          style={delay(AT.framing)}
        />
        <PoseFigure pose={shot.pose} />
      </svg>
      <div className="absolute inset-x-3 top-3 grid justify-end text-xs font-medium">
        <span className="xray-out col-start-1 row-start-1" style={delay(AT.ready)}>
          {t("xray.original")}
        </span>
        <span className="xray-in col-start-1 row-start-1" style={delay(AT.ready)}>
          {director("shoot.shotOf", { index: 1, count: shots })}
        </span>
      </div>
      <Notes shot={shot} />
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 bg-linear-to-t from-studio/90 to-transparent px-3 pt-10 pb-3">
        {line ? (
          <p
            className="xray-in line-clamp-3 text-center text-xs leading-snug"
            style={delay(AT.script)}
          >
            {line.text}
          </p>
        ) : null}
        <span
          className="xray-in grid size-9 place-items-center rounded-full border-2 border-studio-foreground"
          style={delay(AT.ready + 0.1)}
        >
          <span className="size-6 rounded-full bg-record" />
        </span>
      </div>
    </div>
  );
}

const TOKEN_COLORS = {
  key: "text-studio-foreground/60",
  punctuation: "text-studio-foreground/60",
  string: "text-studio-foreground",
  number: "text-aurora-1",
  space: "",
} as const;

/** A line of the panel, its tokens keyed by where each starts. */
function PlanLine({ line }: { line: JsonLine }) {
  const drawnAt = line.field === null ? undefined : DRAWN_AT[line.field];
  const tokens = line.tokens.map((token, index, all) => ({
    token,
    column: all.slice(0, index).reduce((sum, before) => sum + before.text.length, 0),
  }));
  return (
    <span className="xray-in block whitespace-pre" style={delay(0.3 + line.number * 0.045)}>
      <span
        className={cn("-mx-1 rounded-sm px-1", drawnAt !== undefined && "xray-mark")}
        style={drawnAt === undefined ? undefined : delay(drawnAt)}
      >
        {tokens.map(({ token, column }) => (
          <span key={column} className={TOKEN_COLORS[token.kind]}>
            {token.text}
          </span>
        ))}
      </span>
    </span>
  );
}

/** The real JSON behind the phone, lighting up each field as the phone draws it. */
async function PlanPanel({ shot }: { shot: Shot }) {
  const t = await getTranslations("home");
  // In the order the phone draws them, so the panel can follow along as it prints.
  const printed = {
    title: shot.title,
    framing: { shotSize: shot.framing.shotSize, subject: shot.framing.subject },
    pose: { keypoints: shot.pose.keypoints },
    script: shot.script,
    phoneAngle: { height: shot.phoneAngle.height, pitch: shot.phoneAngle.pitch },
  };
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl bg-studio-foreground/6 font-mono text-[0.625rem] leading-[1.125rem] max-sm:h-56 sm:h-0 sm:min-h-full">
      <p className="flex justify-between gap-2 border-b border-studio-foreground/10 px-3 py-1.5 text-studio-foreground/70">
        <span>{t("xray.file")}</span>
        <span>{XRAY.model}</span>
      </p>
      <div className="relative flex-1 overflow-hidden mask-b-from-80% mask-r-from-90%">
        <pre className="xray-follow absolute inset-x-0 px-3 py-2">
          {jsonLines(printed, 54).map((line) => (
            <PlanLine key={line.number} line={line} />
          ))}
        </pre>
      </div>
    </div>
  );
}

/** Every shot of the plan, dealt out as small frames with their framing and camera move. */
async function ShotStrip({ shots }: { shots: Shot[] }) {
  const [t, director] = await Promise.all([getTranslations("home"), getTranslations("director")]);
  return (
    <ol aria-label={t("xray.shots")} className="grid grid-cols-5 gap-2 sm:grid-cols-10">
      {shots.map((shot, index) => {
        const move = moveOf(shot);
        const Icon = MOVE_ICONS[move];
        return (
          <li
            key={shot.sourceStartSeconds}
            className="xray-in flex flex-col gap-1"
            style={delay(AT.shots + index * 0.06)}
          >
            <span className="sr-only">
              {t("xray.shot", { index: index + 1, title: shot.title })}{" "}
              {move === "static" ? t("xray.static") : director(`shoot.doodle.move.${move}`)}
            </span>
            <span aria-hidden className="relative aspect-9/16 rounded-md bg-studio-foreground/8">
              <svg aria-hidden viewBox={VIEW_BOX} className="absolute inset-0 size-full text-guide">
                <rect
                  {...inFrame(shot.framing.subject)}
                  rx={4}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={4}
                />
              </svg>
              <span className="absolute top-1 left-1.5 text-[0.625rem] font-semibold tabular-nums">
                {index + 1}
              </span>
            </span>
            <span
              aria-hidden
              className="flex items-center justify-between gap-1 text-[0.625rem] text-studio-foreground/70"
            >
              <span className="tabular-nums">
                {director("seconds", { seconds: shot.durationSeconds })}
              </span>
              <Icon className="size-3" />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The hero's x-ray of the seed in XRAY, captioned with what it is. */
export async function XRayStage() {
  const t = await getTranslations("home");
  const { plan } = XRAY;
  const [first] = plan.shots;
  return (
    <figure className="flex flex-col gap-4 rounded-3xl bg-studio p-4 text-studio-foreground ring-1 ring-studio-foreground/10 sm:p-6">
      <div aria-hidden className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Phone shot={first} shots={plan.shots.length} />
        <PlanPanel shot={first} />
      </div>
      <ShotStrip shots={plan.shots} />
      <figcaption className="text-sm text-pretty text-studio-foreground/70">
        {t("xray.caption", { title: plan.title, channel: XRAY.channel, shots: plan.shots.length })}
      </figcaption>
    </figure>
  );
}
