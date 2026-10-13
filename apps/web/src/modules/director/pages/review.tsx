"use client";

import { useApiErrorMessage } from "@repo/client";
import { latestTakes } from "@repo/client/api/director/latest";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import { useDirectorTakesQuery } from "@repo/client/api/director/takes";
import type { ShotPlan } from "@repo/contracts/api";
import { buttonVariants } from "@repo/ui/components/button";
import { Spinner } from "@repo/ui/components/spinner";
import { ChevronRight, Pause, Play, Redo2, Undo2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { DirectorGate } from "@/modules/shorts";
import { ClipPanel } from "../components/clip-panel";
import { EditPlayer } from "../components/edit-player";
import { EditTimeline } from "../components/edit-timeline";
import {
  EditTools,
  SoundPanel,
  StylePicker,
  TextEditor,
  type Tool,
} from "../components/edit-tools";
import { type EditChoices, useEditHistory } from "../hooks/use-edit-history";
import { useObjectUrl } from "../hooks/use-object-url";
import { usePlayback } from "../hooks/use-playback";
import { type MediaState, useTakeMedia } from "../hooks/use-take-media";
import { type AudioMode, parseAudio } from "../lib/audio";
import { webVtt } from "../lib/captions";
import {
  type Clip,
  clipAt,
  clipsOf,
  complete,
  type EditLine,
  editLines,
  editSeconds,
} from "../lib/edit";
import { captionInk } from "../lib/ink";
import { OUTPUT_HEIGHT, type Segment, stitch } from "../lib/stitch";
import { timecode } from "../lib/track";

function segmentsOf(clips: readonly Clip[], media: Map<number, MediaState>): Segment[] {
  return clips.map((clip) => {
    const take = media.get(clip.index);
    if (typeof take !== "object") {
      throw new Error("a take isn't loaded yet");
    }
    return clip.shot.kind === "video"
      ? { kind: "video", source: take.blob, startSeconds: clip.from, endSeconds: clip.to }
      : { kind: "photo", source: take.blob, seconds: clip.seconds };
  });
}

/** Renders the edit from the takes in memory; `progress` is null when not rendering. */
function useMakeShort() {
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<Blob | null>(null);
  const [failed, setFailed] = useState(false);
  const make = async (segments: Segment[], lines: readonly EditLine[], choices: EditChoices) => {
    setFailed(false);
    setProgress(0);
    // Made in the tap itself: Safari starts audio only there (see lib/stitch.ts).
    const audioContext = new AudioContext();
    const resumed = audioContext.resume();
    try {
      await resumed;
      const captions = { lines, style: choices.style, ink: captionInk() };
      setResult(
        await stitch(segments, {
          audio: audioContext,
          withSound: choices.sound,
          onProgress: setProgress,
          captions,
        }),
      );
    } catch {
      setFailed(true);
    } finally {
      setProgress(null);
      await audioContext.close();
    }
  };
  return { make, progress, result, failed, close: () => setResult(null) };
}

/** The finished short over the editor: to watch, download, or go back and change. */
function FinishedShort({
  result,
  lines,
  silent,
  onClose,
}: {
  result: Blob;
  lines: readonly EditLine[];
  silent: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("director");
  const locale = useLocale();
  const video = useObjectUrl(result);
  const captions = useObjectUrl(
    useMemo(() => new Blob([webVtt(lines)], { type: "text/vtt" }), [lines]),
  );
  const extension = result.type === "video/mp4" ? "mp4" : "webm";
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
        <h2 className="font-semibold">{t("review.ready")}</h2>
      </div>
      {/* The captions are in the picture; the track is there for screen readers' players. */}
      <video
        src={video ?? undefined}
        controls
        autoPlay
        playsInline
        className="aspect-9/16 max-h-[70dvh] rounded-xl bg-studio-foreground/10"
      >
        <track
          kind="captions"
          src={captions ?? undefined}
          srcLang={locale}
          label={t("review.ready")}
        />
      </video>
      {silent ? (
        <p className="max-w-sm text-center text-xs text-studio-foreground/70">
          {t("review.silent")}
        </p>
      ) : null}
      <a
        href={video ?? undefined}
        download={`director-short.${extension}`}
        className="rounded-full bg-record px-8 py-3 font-semibold text-record-foreground"
      >
        {t("review.download")}
      </a>
    </div>
  );
}

function TopBar({
  videoId,
  title,
  canFinish,
  onNext,
}: {
  videoId: string;
  title: string;
  canFinish: boolean;
  onNext: () => void;
}) {
  const t = useTranslations("director");
  return (
    <header className="flex items-center gap-3 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
      <Link
        href={`/director/${videoId}`}
        aria-label={t("back")}
        className="flex size-10 items-center justify-center rounded-full hover:bg-studio-foreground/10"
      >
        <X className="size-6" aria-hidden />
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
      <span className="rounded-lg bg-studio-foreground/10 px-2.5 py-1.5 text-sm font-semibold">
        {t("editor.quality", { height: OUTPUT_HEIGHT * (9 / 16) })}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={!canFinish}
        className="flex items-center gap-0.5 rounded-xl bg-studio-foreground py-2 pr-2 pl-4 font-semibold text-studio disabled:opacity-40"
      >
        {t("editor.next")}
        <ChevronRight className="size-5" aria-hidden />
      </button>
    </header>
  );
}

function Transport({
  time,
  total,
  playing,
  onPlay,
  history,
}: {
  time: number;
  total: number;
  playing: boolean;
  onPlay: () => void;
  history: ReturnType<typeof useEditHistory>;
}) {
  const t = useTranslations("director.editor");
  return (
    <div className="grid grid-cols-3 items-center px-4 py-1">
      <button
        type="button"
        onClick={onPlay}
        aria-label={playing ? t("pause") : t("play")}
        className="flex size-10 items-center justify-center"
      >
        {playing ? (
          <Pause className="size-7 fill-current" aria-hidden />
        ) : (
          <Play className="size-7 fill-current" aria-hidden />
        )}
      </button>
      <p className="text-center font-mono text-sm leading-tight">
        {timecode(time)}
        <br />
        <span className="text-studio-foreground/60">{timecode(total)}</span>
      </p>
      <div className="flex justify-end gap-4">
        <button
          type="button"
          onClick={history.undo}
          disabled={!history.canUndo}
          aria-label={t("undo")}
          className="disabled:opacity-30"
        >
          <Undo2 className="size-6" aria-hidden />
        </button>
        <button
          type="button"
          onClick={history.redo}
          disabled={!history.canRedo}
          aria-label={t("redo")}
          className="disabled:opacity-30"
        >
          <Redo2 className="size-6" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** Everything the editor holds: the clips, their takes, the clock, the choices, the picks. */
function useEditor(videoId: string, plan: ShotPlan, audio: AudioMode) {
  const takes = useDirectorTakesQuery(videoId);
  const latest = useMemo(() => latestTakes(takes.data ?? []), [takes.data]);
  const clips = useMemo(() => clipsOf(plan.shots, latest), [plan.shots, latest]);
  const media = useTakeMedia(clips);
  const total = editSeconds(clips);
  const playback = usePlayback(total);
  const history = useEditHistory({ style: "pop", texts: {}, sound: audio === "voice" });
  const lines = useMemo(
    () => editLines(clips, history.choices.texts),
    [clips, history.choices.texts],
  );
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const loaded = clips.every((clip) => typeof media.get(clip.index) === "object");
  return {
    takes,
    clips,
    media,
    total,
    playback,
    history,
    lines,
    tool,
    setTool,
    ready: complete(clips) && loaded,
    left: clips.filter((clip) => clip.state === "missing").length,
    focus: clips[selectedClip ?? -1] ?? clipAt(clips, playback.time),
    selectedClip,
    selectedLine,
    selectClip: (clip: Clip) => {
      setSelectedClip(clip.index);
      setSelectedLine(null);
      playback.pause();
      playback.seek(clip.at);
    },
    selectLine: (line: EditLine) => {
      setSelectedLine(line.key);
      setSelectedClip(null);
      setTool("text");
      playback.pause();
      playback.seek(line.startSeconds);
    },
    scrub: (seconds: number) => {
      playback.pause();
      setSelectedClip(null);
      playback.seek(seconds);
    },
  };
}

type EditorState = ReturnType<typeof useEditor>;

/** What shows above the tools: the open tool, or the clip under the playhead. */
function Panel({
  editor,
  videoId,
  audio,
}: {
  editor: EditorState;
  videoId: string;
  audio: AudioMode;
}) {
  const { history, tool, lines, focus } = editor;
  if (tool === "captions") {
    return (
      <StylePicker value={history.choices.style} onChange={(style) => history.change({ style })} />
    );
  }
  if (tool === "text") {
    const line = lines.find((each) => each.key === editor.selectedLine) ?? null;
    return (
      <TextEditor
        key={line?.key ?? "none"}
        line={line}
        onSave={(edited, text) =>
          history.change({ texts: { ...history.choices.texts, [edited.key]: text } })
        }
      />
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
  return focus ? <ClipPanel videoId={videoId} clip={focus} audio={audio} /> : null;
}

function soundLabel(audio: AudioMode, on: boolean) {
  if (audio === "original") {
    return "editor.sound.original";
  }
  return on ? "editor.sound.voice" : "editor.sound.muted";
}

/** The player, with the render's progress over it while the short is being made. */
function Stage({ editor, progress }: { editor: EditorState; progress: number | null }) {
  const t = useTranslations("director.review");
  const { playback, history } = editor;
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
      {progress === null ? null : (
        <div
          aria-live="polite"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-studio/80"
        >
          <Spinner className="size-8" />
          <p className="font-semibold">{t("rendering", { done: progress })}</p>
        </div>
      )}
    </div>
  );
}

/** Below the clock: the timeline, the panel for the open tool or clip, and the tools. */
function Workbench({
  editor,
  videoId,
  audio,
}: {
  editor: EditorState;
  videoId: string;
  audio: AudioMode;
}) {
  const t = useTranslations("director");
  const router = useRouter();
  const { history, focus } = editor;
  return (
    <>
      <EditTimeline
        clips={editor.clips}
        lines={editor.lines}
        media={editor.media}
        total={editor.total}
        time={editor.playback.time}
        onScrub={editor.scrub}
        selectedClip={editor.selectedClip}
        onSelectClip={editor.selectClip}
        selectedLine={editor.selectedLine}
        onSelectLine={editor.selectLine}
        soundLabel={t(soundLabel(audio, history.choices.sound))}
        soundOn={audio === "voice" && history.choices.sound}
      />
      <div className="min-h-20 px-4 py-3">
        {editor.left > 0 && editor.tool === null ? (
          <p className="mb-2 text-xs text-studio-foreground/60">
            {t("review.left", { count: editor.left })}
          </p>
        ) : null}
        <Panel editor={editor} videoId={videoId} audio={audio} />
      </div>
      <EditTools
        tool={editor.tool}
        onTool={editor.setTool}
        onRetake={
          focus
            ? () => router.push(`/director/${videoId}/shoot?shot=${focus.index}&audio=${audio}`)
            : null
        }
      />
    </>
  );
}

function Editor({ videoId, plan, audio }: { videoId: string; plan: ShotPlan; audio: AudioMode }) {
  const t = useTranslations("director");
  const errorMessage = useApiErrorMessage();
  const editor = useEditor(videoId, plan, audio);
  const render = useMakeShort();
  const { playback, history, clips, media, lines } = editor;
  if (editor.takes.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-studio-error">
        {errorMessage(editor.takes.error)}
      </p>
    );
  }
  const next = () => {
    playback.pause();
    void render.make(segmentsOf(clips, media), lines, history.choices);
  };
  return (
    <div className="mx-auto flex h-dvh max-w-lg flex-col">
      <TopBar
        videoId={videoId}
        title={plan.title}
        canFinish={editor.ready && render.progress === null}
        onNext={next}
      />
      <Stage editor={editor} progress={render.progress} />
      {render.failed ? (
        <p role="alert" className="px-4 text-center text-sm text-studio-error">
          {t("review.renderFailed")}
        </p>
      ) : null}
      <Transport
        time={playback.time}
        total={editor.total}
        playing={playback.playing}
        onPlay={playback.playing ? playback.pause : playback.play}
        history={history}
      />
      <Workbench editor={editor} videoId={videoId} audio={audio} />
      {render.result ? (
        <FinishedShort
          result={render.result}
          lines={lines}
          silent={!history.choices.sound}
          onClose={render.close}
        />
      ) : null}
    </div>
  );
}

function Review({ videoId, audio }: { videoId: string; audio: string | undefined }) {
  const t = useTranslations("director");
  const plan = useDirectorPlanQuery(videoId);
  const ready = plan.data?.status === "ready" ? plan.data.plan : null;
  if (ready) {
    return <Editor videoId={videoId} plan={ready} audio={parseAudio(audio, ready)} />;
  }
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
  return (
    <div className="flex h-dvh items-center justify-center">
      <Spinner />
    </div>
  );
}

/** The editor: the member's takes on a timeline, Director's review of each, and the short. */
export function ReviewPage(props: { videoId: string; audio: string | undefined }) {
  return (
    <DirectorGate>
      <Review {...props} />
    </DirectorGate>
  );
}
