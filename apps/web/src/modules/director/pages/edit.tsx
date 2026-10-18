"use client";

import "@fontsource/gochi-hand/400.css";
import "../live.css";
import { useApiErrorMessage } from "@repo/client";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import { useSaveCutMutation } from "@repo/client/api/director/save-cut";
import { useDirectorShotsQuery } from "@repo/client/api/director/shots";
import type { DirectorCut, DirectorShot, ShotPlan } from "@repo/contracts/api";
import { uploadPurposes } from "@repo/contracts/files";
import type { DirectorTakeId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { buttonVariants } from "@repo/ui/components/button";
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
import { DirectorGate } from "@/modules/shorts";
import { EditPlayer } from "../components/edit-player";
import { SoundPanel, StylePicker, type Tool } from "../components/edit-tools";
import { ShotBoard } from "../components/shot-board";
import { type EditChoices, useEditHistory } from "../hooks/use-edit-history";
import { useMemory } from "../hooks/use-memory";
import { useObjectUrl } from "../hooks/use-object-url";
import { usePlayback } from "../hooks/use-playback";
import { shotPage } from "../hooks/use-studio";
import { type MediaState, useTakeMedia } from "../hooks/use-take-media";
import { type AudioMode, parseAudio } from "../lib/audio";
import { webVtt } from "../lib/captions";
import { type Clip, clipsOf, complete, editLines, editSeconds } from "../lib/edit";
import { captionInk } from "../lib/ink";
import { cutPicks, pickedTakes } from "../lib/picks";
import { hush, say } from "../lib/speech";
import { MAX_SECONDS, type Segment, stitch } from "../lib/stitch";
import { timecode } from "../lib/track";

/** A clip's take once it's in memory (not while it loads, nor when it couldn't be). */
function loadedTake(media: Map<DirectorTakeId, MediaState>, clip: Clip) {
  const state = clip.take ? media.get(clip.take.id) : undefined;
  return typeof state === "object" ? state : undefined;
}

function segmentsOf(clips: readonly Clip[], media: Map<DirectorTakeId, MediaState>): Segment[] {
  return clips.map((clip) => {
    const take = required(loadedTake(media, clip), "a loaded take");
    return clip.shot.kind === "video"
      ? { kind: "video", source: take.blob, startSeconds: clip.from, endSeconds: clip.to }
      : { kind: "photo", source: take.blob, seconds: clip.seconds };
  });
}

type Saving =
  | { step: "idle" }
  | { step: "rendering"; done: number }
  | { step: "uploading" }
  | { step: "saved"; video: Blob }
  | { step: "failed"; message: string };

/** What a save is made from: the clips playing, their takes in memory, the choices. */
interface SaveInput {
  clips: readonly Clip[];
  media: Map<DirectorTakeId, MediaState>;
  choices: EditChoices;
  picks: DirectorCut["picks"];
}

/** Renders the edit in the browser, at a size a saved video may be. */
async function render({ clips, media, choices }: SaveInput, onProgress: (done: number) => void) {
  // Made in the tap itself: Safari starts audio only there (see lib/stitch.ts).
  const audio = new AudioContext();
  const resumed = audio.resume();
  try {
    await resumed;
    return await stitch(segmentsOf(clips, media), {
      audio,
      withSound: choices.sound,
      onProgress,
      captions: { lines: editLines(clips), style: choices.style, ink: captionInk() },
    });
  } finally {
    await audio.close();
  }
}

/**
 * Saving the video: rendered here, refused before it's uploaded when it's bigger than a
 * saved video may be, then uploaded and recorded as a cut (it shows in My media).
 */
function useSaveVideo(videoId: string, title: string) {
  const t = useTranslations("director.editor");
  const errorMessage = useApiErrorMessage();
  const saveCut = useSaveCutMutation();
  const [saving, setSaving] = useState<Saving>({ step: "idle" });
  const { maxBytes } = uploadPurposes["director-cut-video"];
  const tooLong = () =>
    setSaving({
      step: "failed",
      message: t("tooLong", { minutes: Math.floor(MAX_SECONDS / 60) }),
    });

  const save = async (input: SaveInput) => {
    // Rendering takes as long as the video plays: not for one that can't be kept.
    if (editSeconds(input.clips) > MAX_SECONDS) {
      return tooLong();
    }
    setSaving({ step: "rendering", done: 0 });
    const video = await render(input, (done) => setSaving({ step: "rendering", done })).catch(
      () => null,
    );
    if (!video) {
      return setSaving({ step: "failed", message: t("renderFailed") });
    }
    if (video.size > maxBytes) {
      return tooLong();
    }
    setSaving({ step: "uploading" });
    const extension = video.type === "video/mp4" ? "mp4" : "webm";
    try {
      await saveCut.mutateAsync({
        videoId,
        title,
        picks: input.picks,
        file: new File([video], `director-${videoId}.${extension}`, { type: video.type }),
      });
      setSaving({ step: "saved", video });
    } catch (error) {
      setSaving({ step: "failed", message: errorMessage(error) });
    }
  };
  const busy = saving.step === "rendering" || saving.step === "uploading";
  return { saving, save, busy, close: () => setSaving({ step: "idle" }) };
}

/** The saved video over the editor: to watch, find in My media, download, or keep editing. */
function Saved({
  video,
  clips,
  onClose,
}: {
  video: Blob;
  clips: readonly Clip[];
  onClose: () => void;
}) {
  const t = useTranslations("director");
  const locale = useLocale();
  const url = useObjectUrl(video);
  const captions = useObjectUrl(
    useMemo(() => new Blob([webVtt(editLines(clips))], { type: "text/vtt" }), [clips]),
  );
  const extension = video.type === "video/mp4" ? "mp4" : "webm";
  return (
    <div className="fixed inset-0 z-30 flex flex-col items-center gap-4 overflow-y-auto bg-studio p-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <div className="flex w-full max-w-lg items-center gap-3">
        <button
          type="button"
          onClick={onClose}
          aria-label={t("editor.backToEdit")}
          className="flex size-9 items-center justify-center rounded-full hover:bg-studio-foreground/10"
        >
          <X className="size-6" aria-hidden />
        </button>
        <h2 className="font-semibold">{t("editor.saved")}</h2>
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
    </div>
  );
}

function TopBar({
  videoId,
  title,
  canSave,
  onSave,
}: {
  videoId: string;
  title: string;
  canSave: boolean;
  onSave: () => void;
}) {
  const t = useTranslations("director");
  return (
    <header className="flex items-center gap-3 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 lg:col-span-2 lg:px-6">
      <Link
        href={`/director/${videoId}`}
        aria-label={t("back")}
        className="flex size-10 items-center justify-center rounded-full hover:bg-studio-foreground/10"
      >
        <X className="size-6" aria-hidden />
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
      <button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        className="rounded-full bg-record px-5 py-2 font-semibold text-record-foreground transition-opacity disabled:opacity-40"
      >
        {t("editor.save")}
      </button>
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

/** Everything the editor holds: the shots and their picks, the takes, the clock, the choices. */
function useEditor(plan: ShotPlan, shots: readonly DirectorShot[], audio: AudioMode) {
  const history = useEditHistory({ style: "pop", sound: audio === "voice", picks: {} });
  const { picks } = history.choices;
  const played = useMemo(() => pickedTakes(shots, picks), [shots, picks]);
  const clips = useMemo(() => clipsOf(plan.shots, played), [plan.shots, played]);
  const media = useTakeMedia(clips);
  const total = editSeconds(clips);
  const playback = usePlayback(total);
  const [tool, setTool] = useState<Tool | null>(null);
  return {
    clips,
    media,
    total,
    playback,
    history,
    tool,
    setTool,
    lines: useMemo(() => editLines(clips), [clips]),
    cutPicks: cutPicks(played),
    ready: complete(clips) && clips.every((clip) => loadedTake(media, clip)),
    left: clips.filter((clip) => clip.state === "missing").length,
    pick: (shotIndex: number, takeId: DirectorTakeId) => {
      history.change({ picks: { ...picks, [shotIndex]: takeId } });
      const clip = required(clips[shotIndex], "the shot picked");
      playback.seek(clip.at);
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
        lines={editor.lines}
        style={history.choices.style}
        sound={history.choices.sound}
        onStall={playback.pause}
      />
      {label === null ? null : (
        <div className="absolute inset-0 flex items-center justify-center bg-studio/80">
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
function Panel({ editor, audio }: { editor: EditorState; audio: AudioMode }) {
  const { history, tool } = editor;
  if (tool === "captions") {
    return (
      <StylePicker value={history.choices.style} onChange={(style) => history.change({ style })} />
    );
  }
  if (tool === "sound") {
    return (
      <SoundPanel
        voice={audio === "voice"}
        on={history.choices.sound}
        onChange={(sound) => history.change({ sound })}
      />
    );
  }
  return null;
}

/**
 * Arriving from the last shot: Director calls the wrap (aloud, when the member has its
 * voice on) and plays the cut it made of the takes, once they've all loaded, so the
 * editor opens on the finished video ready for last changes.
 */
function WrapCall({ ready, play }: { ready: boolean; play: () => void }) {
  const t = useTranslations("director.live");
  const locale = useLocale();
  const [shown, setShown] = useState(true);
  const played = useRef(false);
  const { speak } = useMemory().memory;
  useEffect(() => {
    if (speak) {
      say(t("say.wrap"), locale);
    }
    const timer = window.setTimeout(() => setShown(false), 4500);
    return () => {
      window.clearTimeout(timer);
      hush();
    };
  }, [t, locale, speak]);
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

function Editor({
  videoId,
  plan,
  shots,
  audio,
  wrap,
}: {
  videoId: string;
  plan: ShotPlan;
  shots: readonly DirectorShot[];
  audio: AudioMode;
  wrap: boolean;
}) {
  const t = useTranslations("director");
  const editor = useEditor(plan, shots, audio);
  const saver = useSaveVideo(videoId, plan.title);
  const { playback, history, clips, media } = editor;
  const save = () => {
    playback.pause();
    void saver.save({ clips, media, choices: history.choices, picks: editor.cutPicks });
  };
  return (
    <div className="flex h-dvh flex-col lg:grid lg:grid-cols-[minmax(20rem,28rem)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
      <TopBar
        videoId={videoId}
        title={plan.title}
        canSave={editor.ready && !saver.busy}
        onSave={save}
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
        <Transport editor={editor} />
        {editor.tool ? (
          <div className="px-4 pb-3">
            <Panel editor={editor} audio={audio} />
          </div>
        ) : null}
      </div>
      <div className="flex h-[42dvh] min-h-64 shrink-0 flex-col gap-2 border-t border-studio-foreground/10 pt-3 lg:h-auto lg:min-h-0 lg:border-t-0 lg:border-l lg:pt-4">
        {editor.left > 0 ? (
          <p className="px-4 text-xs text-studio-foreground/60">
            {t("review.left", { count: editor.left })}
          </p>
        ) : null}
        <ShotBoard
          clips={clips}
          shots={shots}
          media={media}
          picks={history.choices.picks}
          time={playback.time}
          playing={playback.playing}
          shotHref={(index) => shotPage(videoId, index, audio)}
          onPick={editor.pick}
          onSeek={editor.seek}
        />
      </div>
      {saver.saving.step === "saved" ? (
        <Saved video={saver.saving.video} clips={clips} onClose={saver.close} />
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
  if (!ready || !shots.data) {
    return <Loading />;
  }
  return (
    <Editor
      videoId={videoId}
      plan={ready}
      shots={shots.data}
      audio={parseAudio(audio, ready)}
      wrap={wrap}
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
