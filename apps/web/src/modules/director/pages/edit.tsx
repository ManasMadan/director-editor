"use client";

import "@fontsource/gochi-hand/400.css";
import "../live.css";
import { useApiErrorMessage } from "@repo/client";
import { useAssetSlotsQuery } from "@repo/client/api/assets/slots";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import { useSaveCutMutation } from "@repo/client/api/director/save-cut";
import { useDirectorShotsQuery } from "@repo/client/api/director/shots";
import { useYourVersionQuery } from "@repo/client/api/director/your-version";
import { useSliceUploader } from "@repo/client/api/recording/upload-slices";
import type {
  AssetSlot,
  DirectorCut,
  DirectorShot,
  EditorReply,
  ServedShotPlan,
  YourVersion,
} from "@repo/contracts/api";
import { uploadPurposes } from "@repo/contracts/files";
import type { DirectorTakeId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { buttonVariants } from "@repo/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@repo/ui/components/dialog";
import { GeminiLoader, GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import {
  AudioLines,
  Captions,
  Download,
  Pause,
  Play,
  Redo2,
  Undo2,
  VolumeX,
  X,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { DirectorGate } from "@/modules/shorts";
import { BackToPicks } from "../components/directors-picks";
import { EditPlayer } from "../components/edit-player";
import { SoundPanel, StylePicker, type Tool } from "../components/edit-tools";
import { GapStrip } from "../components/gap-strip";
import { MatchCutNotes } from "../components/match-cut";
import { ShotBoard } from "../components/shot-board";
import { TellDirector } from "../components/tell-director";
import { VersionGaps } from "../components/version-gaps";
import { type EditChoices, useEditHistory } from "../hooks/use-edit-history";
import { useEditorTalk } from "../hooks/use-editor-talk";
import { useMatchCuts } from "../hooks/use-match-cuts";
import { useObjectUrl } from "../hooks/use-object-url";
import { usePlayback } from "../hooks/use-playback";
import { shotPage } from "../hooks/use-studio";
import { type MediaState, useTakeMedia } from "../hooks/use-take-media";
import { type AudioMode, parseAudio } from "../lib/audio";
import { type CaptionLine, webVtt } from "../lib/captions";
import { composer, type Picture } from "../lib/compose";
import { type Clip, clipsOf, editLines, editSeconds, playsAsGap } from "../lib/edit";
import { arrange, editorState, fixLines, UNARRANGED, withPick } from "../lib/editor-actions";
import { gradeFilter } from "../lib/grades";
import { captionInk } from "../lib/ink";
import type { MatchCutTransform } from "../lib/match-cuts";
import { cutPicks, pickedTakes } from "../lib/picks";
import { gapSlots } from "../lib/scene";
import { MAX_SECONDS, type Segment, stitch } from "../lib/stitch";
import { timecode } from "../lib/track";
import {
  loadVisuals,
  posterPicture,
  releaseVisuals,
  type SlotMedia,
  slotMedia,
} from "../lib/visuals";
import { adaptationOf, films, yourVersion } from "../lib/your-version";

/**
 * A filmed clip's take once it's in memory (not while it loads, nor when it couldn't be).
 * Asked only of a filmed clip (a gap has no take).
 */
function loadedTake(media: Map<DirectorTakeId, MediaState>, clip: Clip) {
  const state = media.get(required(clip.take, "a filmed take").id);
  return typeof state === "object" ? state : undefined;
}

function segmentsOf(
  clips: readonly Clip[],
  media: Map<DirectorTakeId, MediaState>,
  transforms: ReadonlyMap<number, MatchCutTransform>,
): Segment[] {
  return clips.map((clip): Segment => {
    // A gap, or a shot not filmed: its B-roll, or the nearest shot held (lib/compose.ts).
    if (playsAsGap(clip)) {
      return { kind: "gap", seconds: clip.seconds };
    }
    const take = required(loadedTake(media, clip), "a loaded take");
    const filter = gradeFilter(clip.grade);
    return clip.shot.kind === "video"
      ? {
          kind: "video",
          source: take.blob,
          startSeconds: clip.from,
          endSeconds: clip.to,
          transform: transforms.get(clip.index),
          filter,
        }
      : { kind: "photo", source: take.blob, seconds: clip.seconds, filter };
  });
}

type Saving =
  | { step: "idle" }
  | { step: "rendering"; done: number }
  | { step: "uploading" }
  /** With the clips that were rendered, for the saved video's captions track. */
  | { step: "saved"; video: Blob; lines: readonly CaptionLine[] }
  | { step: "failed"; message: string };

/** What a save is made from: the clips playing, their takes in memory, the choices. */
interface SaveInput {
  plan: ServedShotPlan;
  /** Each slot's chosen picture (assets and gaps), read when the video is made. */
  slots: ReadonlyMap<string, SlotMedia>;
  clips: readonly Clip[];
  media: Map<DirectorTakeId, MediaState>;
  choices: EditChoices;
  picks: DirectorCut["picks"];
  /** How each clip a match cut lined up is drawn (lib/match-cuts.ts). */
  transforms: ReadonlyMap<number, MatchCutTransform>;
}

/** Renders the edit in the browser, at a size a saved video may be, until `signal` cancels. */
async function render(
  { plan, slots, clips, media, choices, transforms }: SaveInput,
  onProgress: (done: number) => void,
  signal: AbortSignal,
) {
  // Made in the tap itself: Safari starts audio only there (see lib/stitch.ts).
  const audio = new AudioContext();
  const resumed = audio.resume();
  const visuals = await loadVisuals(slots);
  try {
    await resumed;
    const hold = await heldPicture(clips, media);
    return await stitch(segmentsOf(clips, media, transforms), {
      audio,
      withSound: choices.sound,
      onProgress,
      captions: {
        lines: fixLines(editLines(clips), choices.fixes),
        style: choices.style,
        ink: captionInk(),
      },
      signal,
      look: (ctx) => composer(ctx, plan, clips, visuals, hold),
    });
  } finally {
    releaseVisuals(visuals);
    await audio.close();
  }
}

/**
 * The first filmed shot's card frame: what a skipped shot at the very start holds when
 * nothing fills it (later ones hold the shot before them).
 */
async function heldPicture(
  clips: readonly Clip[],
  media: Map<DirectorTakeId, MediaState>,
): Promise<Picture | null> {
  const first = clips.find((clip) => clip.state === "cut");
  const take = first ? loadedTake(media, first) : undefined;
  if (!take) {
    return null;
  }
  return posterPicture(take.poster);
}

const MEGABYTE = 1_000_000;

/**
 * Saving the video: rendered here, refused before it's uploaded when it's bigger than a
 * saved video may be, then uploaded and recorded as a cut (it shows in My media). Cancel,
 * or leaving the editor, stops the render or the upload and saves nothing.
 */
function useSaveVideo(videoId: string, title: string) {
  const t = useTranslations("director.editor");
  const errorMessage = useApiErrorMessage();
  const saveCut = useSaveCutMutation();
  const [saving, setSaving] = useState<Saving>({ step: "idle" });
  const running = useRef<AbortController | null>(null);
  // Leaving mid-save: nobody would watch it, so the render (or upload) stops.
  useEffect(() => () => running.current?.abort(), []);
  const fail = (message: string) => setSaving({ step: "failed", message });
  const { maxBytes } = uploadPurposes["director-cut-video"];

  const upload = async (input: SaveInput, video: Blob, signal: AbortSignal) => {
    setSaving({ step: "uploading" });
    const extension = video.type === "video/mp4" ? "mp4" : "webm";
    try {
      await saveCut.mutateAsync({
        videoId,
        title,
        picks: input.picks,
        file: new File([video], `director-${videoId}.${extension}`, { type: video.type }),
        signal,
      });
      // Cancelled while the cut was being recorded, too late to stop it: the member was
      // already shown the editor again, so it isn't put back over it.
      if (signal.aborted) {
        return;
      }
      setSaving({
        step: "saved",
        video,
        lines: fixLines(editLines(input.clips), input.choices.fixes),
      });
    } catch (error) {
      if (!signal.aborted) {
        fail(errorMessage(error));
      }
    }
  };

  const save = async (input: SaveInput) => {
    // Rendering takes as long as the video plays: not for one that can't be kept.
    if (editSeconds(input.clips) > MAX_SECONDS) {
      return fail(t("tooLong", { minutes: Math.floor(MAX_SECONDS / 60) }));
    }
    const cancel = new AbortController();
    running.current = cancel;
    setSaving({ step: "rendering", done: 0 });
    // No progress comes after a cancel: the render stops before its next frame.
    const onProgress = (done: number) => setSaving({ step: "rendering", done });
    const video = await render(input, onProgress, cancel.signal).catch(() => null);
    if (cancel.signal.aborted) {
      return;
    }
    if (!video) {
      return fail(t("renderFailed"));
    }
    // A short video whose picture came out busier than the bitrate allows.
    if (video.size > maxBytes) {
      return fail(t("tooBig", { megabytes: maxBytes / MEGABYTE }));
    }
    await upload(input, video, cancel.signal);
  };
  const busy = saving.step === "rendering" || saving.step === "uploading";
  return {
    saving,
    save,
    busy,
    cancel: () => {
      running.current?.abort();
      setSaving({ step: "idle" });
    },
    close: () => setSaving({ step: "idle" }),
  };
}

/** The saved video over the editor: to watch, find in My media, download, or keep editing. */
function Saved({
  video,
  lines,
  onClose,
}: {
  video: Blob;
  lines: readonly CaptionLine[];
  onClose: () => void;
}) {
  const t = useTranslations("director");
  const locale = useLocale();
  const url = useObjectUrl(video);
  const captions = useObjectUrl(
    useMemo(() => new Blob([webVtt(lines)], { type: "text/vtt" }), [lines]),
  );
  const extension = video.type === "video/mp4" ? "mp4" : "webm";
  return (
    // Controlled and always open while shown: its only change is closing.
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col items-center gap-4 overflow-y-auto rounded-none bg-studio p-4 pt-[max(1rem,env(safe-area-inset-top))] text-studio-foreground ring-0 sm:max-w-none"
      >
        <div className="flex w-full max-w-lg items-center gap-3">
          <DialogClose
            aria-label={t("editor.backToEdit")}
            className="flex size-9 items-center justify-center rounded-full hover:bg-studio-foreground/10"
          >
            <X className="size-6" aria-hidden />
          </DialogClose>
          <DialogTitle className="text-base font-semibold">{t("editor.saved")}</DialogTitle>
        </div>
        {/* The captions are in the picture; the track is there for screen readers' players. */}
        <video
          src={url ?? undefined}
          controls
          autoPlay
          playsInline
          className="aspect-9/16 max-h-[65dvh] rounded-xl bg-studio-foreground/10"
        >
          <track
            kind="captions"
            src={captions ?? undefined}
            srcLang={locale}
            label={t("editor.saved")}
          />
        </video>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/media"
            className="rounded-full bg-record px-6 py-3 font-semibold text-record-foreground"
          >
            {t("editor.openMedia")}
          </Link>
          <a
            href={url ?? undefined}
            download={`director-short.${extension}`}
            className="flex items-center gap-2 rounded-full bg-studio-foreground/10 px-5 py-3 font-semibold"
          >
            <Download className="size-4" aria-hidden />
            {t("review.download")}
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TopBar({
  videoId,
  title,
  canSave,
  busy,
  onSave,
  onCancel,
}: {
  videoId: string;
  title: string;
  canSave: boolean;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("director");
  const common = useTranslations("common");
  return (
    <header className="flex items-center gap-3 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 lg:col-span-2 lg:px-6">
      {/* Leaving mid-save stops it (useSaveVideo), so the way out stays open. */}
      <Link
        href={`/director/${videoId}`}
        aria-label={t("back")}
        className="flex size-10 items-center justify-center rounded-full hover:bg-studio-foreground/10"
      >
        <X className="size-6" aria-hidden />
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
      {busy ? (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full bg-studio-foreground/15 px-5 py-2 font-semibold"
        >
          {common("cancel")}
        </button>
      ) : (
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="rounded-full bg-record px-5 py-2 font-semibold text-record-foreground transition-opacity disabled:opacity-40"
        >
          {t("editor.save")}
        </button>
      )}
    </header>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={label}
      className={cn(
        "flex size-10 items-center justify-center rounded-full transition-colors disabled:opacity-30",
        pressed && "bg-studio-foreground/15",
      )}
    >
      {children}
    </button>
  );
}

/** Play and the clock, the two settings, and undo and redo (of picks and settings alike). */
function Transport({ editor }: { editor: EditorState }) {
  const t = useTranslations("director.editor");
  const { playback, history, tool, setTool, total } = editor;
  const toggle = (next: Tool) => setTool(tool === next ? null : next);
  const SoundIcon = history.choices.sound ? AudioLines : VolumeX;
  return (
    <div className="flex items-center gap-1 px-3 py-1">
      <IconButton
        label={playback.playing ? t("pause") : t("play")}
        onClick={playback.playing ? playback.pause : playback.play}
      >
        {playback.playing ? (
          <Pause className="size-6 fill-current" aria-hidden />
        ) : (
          <Play className="size-6 fill-current" aria-hidden />
        )}
      </IconButton>
      <p className="font-mono text-sm tabular-nums">
        <span>{timecode(playback.time)}</span>
        <span className="text-studio-foreground/50"> / {timecode(total)}</span>
      </p>
      <span className="flex-1" />
      <IconButton
        label={t("tools.captions")}
        pressed={tool === "captions"}
        onClick={() => toggle("captions")}
      >
        <Captions className="size-5" aria-hidden />
      </IconButton>
      <IconButton
        label={t("tools.sound")}
        pressed={tool === "sound"}
        onClick={() => toggle("sound")}
      >
        <SoundIcon className="size-5" aria-hidden />
      </IconButton>
      <IconButton label={t("undo")} onClick={history.undo} disabled={!history.canUndo}>
        <Undo2 className="size-5" aria-hidden />
      </IconButton>
      <IconButton label={t("redo")} onClick={history.redo} disabled={!history.canRedo}>
        <Redo2 className="size-5" aria-hidden />
      </IconButton>
    </div>
  );
}

const NO_CLIPS: readonly Clip[] = [];
// The slots while they load (or when the picker's off): every asset shows its default.
const NO_SLOTS: readonly AssetSlot[] = [];

/** A take Director offered as a choice, as a clip, so it loads for its preview. */
function candidateClips(
  reply: EditorReply | null,
  byShot: readonly Clip[],
  shots: readonly DirectorShot[],
) {
  return (reply?.choices ?? []).flatMap((choice): Clip[] => {
    const clip = byShot.find((one) => one.index === choice.shotIndex);
    const take = shots[choice.shotIndex]?.takes.find((one) => one.id === choice.takeId);
    if (!clip || !take || take.status !== "ready") {
      return [];
    }
    const from = Math.max(0, choice.atSeconds - 1);
    return [{ ...clip, take, state: "cut", from, to: from + 2 }];
  });
}

/** The shot a request or a pick just changed: played, and outlined on the board a moment. */
function useHighlight(clips: readonly Clip[], seek: (seconds: number) => void) {
  const [highlight, setHighlight] = useState<number | null>(null);
  useEffect(() => {
    if (highlight === null) {
      return;
    }
    const timer = window.setTimeout(() => setHighlight(null), 1500);
    return () => window.clearTimeout(timer);
  }, [highlight]);
  const showShot = (shotIndex: number) => {
    setHighlight(shotIndex);
    const clip = clips.find((one) => one.index === shotIndex);
    if (clip) {
      seek(clip.at);
    }
  };
  return { highlight, showShot };
}

/**
 * The clips that play: each filmed shot's picked take in the member's version (`byShot`,
 * what Director reads), then the member's order, trims and grades, then the plan's match
 * cuts lined up.
 */
function useArrangedClips(
  videoId: string,
  plan: ServedShotPlan,
  shots: readonly DirectorShot[],
  choices: EditChoices,
  version: YourVersion,
) {
  const { picks } = choices;
  // Only the shots the member's version films reach the video (and the saved picks).
  const played = useMemo(
    () =>
      pickedTakes(
        shots.filter((shot) => films(version, shot.index)),
        picks,
      ),
    [shots, picks, version],
  );
  const byShot = useMemo(
    () =>
      clipsOf(
        plan.shots.map((shot, index) => yourVersion(shot, adaptationOf(version, index)).shot),
        played,
        // A shot the member's version leaves as a gap (an angle they chose not to film)
        // stays in the edit with no take: the editor fills it with B-roll.
        (index) => {
          if (version.gaps.includes(index)) {
            return "gap";
          }
          return films(version, index) ? "filmed" : null;
        },
      ),
    [plan.shots, played, version],
  );
  const arranged = useMemo(() => arrange(byShot, choices), [byShot, choices]);
  // The plan's match cuts join shots that follow each other in its order: once the member
  // reorders or drops shots, they're cut plainly.
  const inPlanOrder = choices.order === null && choices.dropped.length === 0;
  const matchCuts = useMatchCuts(videoId, plan, inPlanOrder ? arranged : NO_CLIPS);
  const clips = inPlanOrder ? matchCuts.clips : arranged;
  // Only the shots that play go into a saved cut: a dropped one isn't in the video.
  const playing = new Map(
    [...played].filter(([index]) => clips.some((clip) => clip.index === index)),
  );
  return { playing, byShot, clips, matchCuts };
}

/**
 * Whether the video can be made: at least one shot filmed, none still being reviewed,
 * and every filmed one in memory. A shot not filmed plays as a gap to fill (the member
 * with three minutes saves what they have); the editor says so above the board, with
 * "Film it" on the shot.
 */
function readyToSave(clips: readonly Clip[], media: Map<DirectorTakeId, MediaState>) {
  const filmed = clips.filter((clip) => clip.state === "cut");
  return (
    filmed.length > 0 &&
    clips.every((clip) => clip.state !== "reviewing") &&
    filmed.every((clip) => loadedTake(media, clip))
  );
}

/** Everything the editor holds: the shots and their picks, the takes, the clock, the choices. */
function useEditor(
  videoId: string,
  plan: ServedShotPlan,
  shots: readonly DirectorShot[],
  audio: AudioMode,
  version: YourVersion,
  owner: string | null,
) {
  // Kept in this tab per member and template: a reload or a reshoot comes back to them.
  const history = useEditHistory(
    { style: "pop", sound: audio === "voice", picks: {}, ...UNARRANGED },
    owner === null ? null : `${owner}:${videoId}`,
  );
  const { playing, byShot, clips, matchCuts } = useArrangedClips(
    videoId,
    plan,
    shots,
    history.choices,
    version,
  );
  const [reply, setReply] = useState<EditorReply | null>(null);
  const media = useTakeMedia([...clips, ...candidateClips(reply, byShot, shots)]);
  const total = editSeconds(clips);
  const playback = usePlayback(total);
  const [tool, setTool] = useState<Tool | null>(null);
  const { highlight, showShot } = useHighlight(clips, playback.seek);
  return {
    byShot,
    clips,
    media,
    total,
    playback,
    history,
    tool,
    setTool,
    reply,
    setReply,
    highlight,
    showShot,
    lines: useMemo(
      () => fixLines(editLines(clips), history.choices.fixes),
      [clips, history.choices.fixes],
    ),
    matchCuts,
    cutPicks: cutPicks(playing),
    ready: readyToSave(clips, media),
    gaps: useMemo(() => gapSlots(plan, clips), [plan, clips]),
    left: clips.filter((clip) => clip.state === "missing").length,
    pick: (shotIndex: number, takeId: DirectorTakeId) => {
      history.change(withPick(history.choices, shotIndex, takeId));
      showShot(shotIndex);
    },
    seek: (clip: Clip) => {
      playback.pause();
      playback.seek(clip.at);
    },
  };
}

type EditorState = ReturnType<typeof useEditor>;

/** The player, with the save's progress over it while the video is made and uploaded. */
function Stage({ editor, saving }: { editor: EditorState; saving: Saving }) {
  const t = useTranslations("director.editor");
  const { playback, history } = editor;
  const labels: Partial<Record<Saving["step"], string>> = {
    rendering: t("rendering", { done: saving.step === "rendering" ? saving.done : 0 }),
    uploading: t("uploading"),
  };
  const label = labels[saving.step] ?? null;
  return (
    <div className="relative flex min-h-0 flex-1 justify-center px-4 py-2">
      <EditPlayer
        clips={editor.clips}
        media={editor.media}
        time={playback.time}
        playing={playback.playing}
        clock={playback.clock}
        transforms={editor.matchCuts.transforms}
        lines={editor.lines}
        style={history.choices.style}
        sound={history.choices.sound}
        onStall={playback.pause}
      />
      {label === null ? null : (
        <div className="absolute inset-0 flex items-center justify-center bg-studio/90">
          <GeminiLoader
            label={label}
            showLabel
            size="lg"
            className="*:last:font-semibold *:last:text-studio-foreground"
          />
        </div>
      )}
    </div>
  );
}

/** The open setting, under the transport. */
function Panel({ editor, tool, audio }: { editor: EditorState; tool: Tool; audio: AudioMode }) {
  const { history } = editor;
  if (tool === "captions") {
    return (
      <StylePicker value={history.choices.style} onChange={(style) => history.change({ style })} />
    );
  }
  return (
    <SoundPanel
      voice={audio === "voice"}
      on={history.choices.sound}
      onChange={(sound) => history.change({ sound })}
    />
  );
}

/**
 * Arriving from the last shot: the wrap card, and the cut Director made of the takes
 * playing once they've all loaded, so the editor opens on the finished video ready for
 * last changes.
 */
function WrapCall({ ready, play }: { ready: boolean; play: () => void }) {
  const t = useTranslations("director.editor");
  const [shown, setShown] = useState(true);
  const played = useRef(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(false), 4500);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (ready && !played.current) {
      played.current = true;
      play();
    }
  }, [ready, play]);
  if (!shown) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => setShown(false)}
      className="live-motion absolute inset-x-6 top-6 z-10 flex animate-[live-rise_500ms_cubic-bezier(.2,.9,.3,1.2)_both] flex-col items-center gap-1 rounded-3xl bg-doodle-paper px-5 py-4 text-studio shadow-2xl"
    >
      <span className="-rotate-2 font-[family-name:var(--font-hand)] text-3xl">
        {t("wrap.title")}
      </span>
      <span className="text-sm text-balance">{t("wrap.body")}</span>
    </button>
  );
}

/** The shots and their takes, and the "tell Director" bar under them. */
function BoardPanel({
  videoId,
  audio,
  plan,
  version,
  editor,
  shots,
  busy,
  slots,
}: {
  videoId: string;
  audio: AudioMode;
  plan: ServedShotPlan;
  version: YourVersion;
  editor: EditorState;
  shots: readonly DirectorShot[];
  busy: boolean;
  /** The asset picker's slots, the gaps' among them. */
  slots: readonly AssetSlot[];
}) {
  const t = useTranslations("director");
  const { playback, history, clips, media } = editor;
  return (
    <div className="flex h-[42dvh] min-h-64 shrink-0 flex-col gap-2 border-t border-studio-foreground/10 pt-3 lg:h-auto lg:min-h-0 lg:border-t-0 lg:border-l lg:pt-4">
      {editor.left > 0 ? (
        <p className="px-4 text-xs text-studio-foreground/60">
          {t("review.left", { count: editor.left })}
        </p>
      ) : null}
      <MatchCutNotes cuts={editor.matchCuts.cuts} />
      <VersionGaps plan={plan} version={version} />
      <BackToPicks
        shots={shots}
        picks={history.choices.picks}
        onReset={(picks) => history.change({ picks })}
      />
      <GapStrip videoId={videoId} plan={plan} gaps={editor.gaps} slots={slots} locked={busy} />
      <ShotBoard
        clips={clips}
        shots={shots}
        media={media}
        picks={history.choices.picks}
        time={playback.time}
        playing={playback.playing}
        shotHref={(index) => shotPage(videoId, index, audio, true)}
        onPick={editor.pick}
        onSeek={editor.seek}
        locked={busy}
        highlight={editor.highlight}
      />
      <div inert={busy} className={cn(busy && "opacity-40")}>
        <TalkBar videoId={videoId} audio={audio} editor={editor} shots={shots} />
      </div>
    </div>
  );
}

/** The "tell Director" bar, wired to the editor. */
function TalkBar({
  videoId,
  audio,
  editor,
  shots,
}: {
  videoId: string;
  audio: AudioMode;
  editor: EditorState;
  shots: readonly DirectorShot[];
}) {
  const talk = useEditorTalk(videoId, audio, editor);
  const { history, playback } = editor;
  const dismiss = () => {
    editor.setReply(null);
    talk.dismiss();
  };
  return (
    <TellDirector
      reply={editor.reply}
      pending={talk.pending}
      error={talk.error}
      shots={shots}
      media={editor.media}
      onSend={(request) =>
        void talk.send(request, editorState(editor.byShot, history.choices, false))
      }
      onListen={playback.pause}
      onPick={(shotIndex, takeId) => {
        editor.pick(shotIndex, takeId);
        dismiss();
      }}
      onUndo={() => {
        history.undo();
        dismiss();
      }}
      onDismiss={dismiss}
    />
  );
}

function Editor({
  videoId,
  plan,
  shots,
  audio,
  wrap,
  version,
  owner,
}: {
  videoId: string;
  plan: ServedShotPlan;
  shots: readonly DirectorShot[];
  audio: AudioMode;
  wrap: boolean;
  /** The member's version: its skipped shots and gaps aren't in the video. */
  version: YourVersion;
  /** The signed-in member, whose choices are kept for the next visit. */
  owner: string | null;
}) {
  const editor = useEditor(videoId, plan, shots, audio, version, owner);
  const saver = useSaveVideo(videoId, plan.title);
  const assetSlots = useAssetSlotsQuery(videoId).data?.slots ?? NO_SLOTS;
  const { playback, history, clips, media } = editor;
  const save = () => {
    playback.pause();
    void saver.save({
      plan,
      slots: slotMedia(plan, assetSlots),
      clips,
      media,
      choices: history.choices,
      picks: editor.cutPicks,
      transforms: editor.matchCuts.transforms,
    });
  };
  return (
    <div className="flex h-dvh flex-col lg:grid lg:grid-cols-[minmax(20rem,28rem)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
      <TopBar
        videoId={videoId}
        title={plan.title}
        canSave={editor.ready}
        busy={saver.busy}
        onSave={save}
        onCancel={saver.cancel}
      />
      <div className="flex min-h-0 flex-1 flex-col lg:pb-4">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Stage editor={editor} saving={saver.saving} />
          {wrap ? <WrapCall ready={editor.ready} play={playback.play} /> : null}
        </div>
        {saver.saving.step === "failed" ? (
          <p role="alert" className="px-4 text-center text-sm text-studio-error">
            {saver.saving.message}
          </p>
        ) : null}
        {/* Held still while the video is made: what it's made of can't change under it. */}
        <div inert={saver.busy} className={cn(saver.busy && "opacity-40")}>
          <Transport editor={editor} />
          {editor.tool ? (
            <div className="px-4 pb-3">
              <Panel editor={editor} tool={editor.tool} audio={audio} />
            </div>
          ) : null}
        </div>
      </div>
      <BoardPanel
        videoId={videoId}
        audio={audio}
        plan={plan}
        version={version}
        editor={editor}
        shots={shots}
        busy={saver.busy}
        slots={assetSlots}
      />
      {saver.saving.step === "saved" ? (
        <Saved video={saver.saving.video} lines={saver.saving.lines} onClose={saver.close} />
      ) : null}
    </div>
  );
}

/** While the shots load: the player's frame and a few columns, shimmering. */
function Loading() {
  const t = useTranslations("director.editor");
  return (
    <div className="flex h-dvh flex-col items-center gap-4 p-4">
      <GeminiShimmer className="aspect-9/16 h-1/2 rounded-xl bg-studio-foreground/10" />
      <div className="flex w-full gap-3">
        {[0, 1, 2].map((column) => (
          <GeminiShimmer key={column} className="h-40 w-40 shrink-0 bg-studio-foreground/10" />
        ))}
      </div>
      <GeminiLoader label={t("loadingTakes")} />
    </div>
  );
}

function Edit({
  videoId,
  audio,
  wrap,
}: {
  videoId: string;
  audio: string | undefined;
  wrap: boolean;
}) {
  const t = useTranslations("director");
  const errorMessage = useApiErrorMessage();
  const plan = useDirectorPlanQuery(videoId);
  const ready = plan.data?.status === "ready" ? plan.data.plan : null;
  const shots = useDirectorShotsQuery(videoId, ready !== null);
  const version = useYourVersionQuery(videoId);
  const session = authClient.useSession();
  // The shoot's footage still on this device (the member opened the editor without
  // waiting after Done) goes on uploading here; its takes appear as they're cut.
  useSliceUploader();
  if (plan.isError) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
        <p>{t("progress.pending")}</p>
        <Link href={`/director/${videoId}`} className={buttonVariants({ variant: "secondary" })}>
          {t("back")}
        </Link>
      </div>
    );
  }
  if (shots.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-studio-error">
        {errorMessage(shots.error)}
      </p>
    );
  }
  if (version.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-studio-error">
        {errorMessage(version.error)}
      </p>
    );
  }
  // The member is known before the editor opens: their kept choices are read once, then.
  if (!ready || !shots.data || !version.data || session.isPending) {
    return <Loading />;
  }
  return (
    <Editor
      videoId={videoId}
      plan={ready}
      shots={shots.data}
      audio={parseAudio(audio, ready)}
      wrap={wrap}
      version={version.data}
      owner={session.data?.user.id ?? null}
    />
  );
}

/** The editor: the member's takes shot by shot, Director's picks, and saving the video. */
export function EditPage(props: { videoId: string; audio: string | undefined; wrap: boolean }) {
  return (
    <DirectorGate>
      <Edit {...props} />
    </DirectorGate>
  );
}
