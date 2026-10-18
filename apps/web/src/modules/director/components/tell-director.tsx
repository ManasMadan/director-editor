"use client";

import { useApiErrorMessage } from "@repo/client";
import type { DirectorShot, EditorReply } from "@repo/contracts/api";
import type { DirectorTakeId } from "@repo/contracts/ids";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { Mic, SendHorizontal, Square, Undo2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useRef, useState } from "react";
import type { MediaState } from "../hooks/use-take-media";
import type { Spoken } from "../hooks/use-tell-director";
import { takeNumber } from "../lib/picks";

const SPOKEN_TYPES = ["audio/webm", "audio/mp4", "audio/ogg"] as const;

/** The recording type this browser makes, as the API names it (codecs dropped). */
function spokenType(recorder: MediaRecorder): Spoken["audioType"] | null {
  return SPOKEN_TYPES.find((type) => recorder.mimeType.startsWith(type)) ?? null;
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("the recording couldn't be read"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Saying a request: the microphone records until stop, then the recording goes to
 * Director as it is (Gemini hears it; nothing is transcribed in the browser).
 */
function useVoice(onSpoken: (spoken: Spoken) => void) {
  const [listening, setListening] = useState(false);
  const [failed, setFailed] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const start = async () => {
    setFailed(false);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    if (!stream) {
      setFailed(true);
      return;
    }
    const recording = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recording.ondataavailable = (event) => chunks.push(event.data);
    recording.onstop = () => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      setListening(false);
      const audioType = spokenType(recording);
      if (!audioType) {
        setFailed(true);
        return;
      }
      void base64Of(new Blob(chunks, { type: recording.mimeType })).then(
        (audio) => onSpoken({ audio, audioType }),
        () => setFailed(true),
      );
    };
    recorder.current = recording;
    recording.start();
    setListening(true);
  };
  return { listening, failed, start, stop: () => recorder.current?.stop() };
}

/** A candidate take, looping near its moment, to tap and use. */
function Choice({
  choice,
  shots,
  media,
  onPick,
}: {
  choice: EditorReply["choices"][number];
  shots: readonly DirectorShot[];
  media: Map<DirectorTakeId, MediaState>;
  onPick: (shotIndex: number, takeId: DirectorTakeId) => void;
}) {
  const t = useTranslations("director.editor.talk");
  const shot = shots[choice.shotIndex];
  const state = media.get(choice.takeId);
  const label = t("choice", {
    shot: choice.shotIndex + 1,
    take: shot ? takeNumber(shot, choice.takeId) : 0,
    note: choice.note,
  });
  return (
    <li className="w-28 shrink-0">
      <button
        type="button"
        onClick={() => onPick(choice.shotIndex, choice.takeId)}
        aria-label={label}
        title={t("use")}
        className="flex w-full flex-col gap-1 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-record"
      >
        {typeof state === "object" ? (
          <video
            src={state.url}
            muted
            loop
            autoPlay
            playsInline
            aria-hidden
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime = Math.max(0, choice.atSeconds - 1);
            }}
            className="aspect-9/16 w-full rounded-lg bg-studio-foreground/10 object-cover"
          />
        ) : (
          <span className="aspect-9/16 w-full animate-pulse rounded-lg bg-studio-foreground/10" />
        )}
        <span className="line-clamp-2 text-xs">{label}</span>
      </button>
    </li>
  );
}

function Answer({
  reply,
  shots,
  media,
  onPick,
  onUndo,
  onDismiss,
}: {
  reply: EditorReply;
  shots: readonly DirectorShot[];
  media: Map<DirectorTakeId, MediaState>;
  onPick: (shotIndex: number, takeId: DirectorTakeId) => void;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("director.editor.talk");
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-studio-foreground/10 p-3">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm">{reply.say}</p>
        {reply.outcome === "applied" && reply.actions.length > 0 ? (
          <button
            type="button"
            onClick={onUndo}
            className="flex min-h-11 items-center gap-1 rounded-full bg-studio-foreground/15 px-3 text-sm font-semibold"
          >
            <Undo2 className="size-4" aria-hidden />
            {t("undo")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("dismiss")}
          className="flex size-11 items-center justify-center rounded-full hover:bg-studio-foreground/10"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {reply.choices.length > 0 ? (
        <ul aria-label={t("choices")} className="flex gap-2 overflow-x-auto">
          {reply.choices.map((choice) => (
            <Choice
              key={`${choice.shotIndex}:${choice.takeId}`}
              choice={choice}
              shots={shots}
              media={media}
              onPick={onPick}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The "tell Director" bar under the editor: type or say what to change, and Director's
 * one-line answer above it, with Undo when it changed something and candidate takes when
 * it needs a choice. Its answer is announced to screen readers.
 */
export function TellDirector({
  reply,
  pending,
  error,
  shots,
  media,
  onSend,
  onListen,
  onPick,
  onUndo,
  onDismiss,
}: {
  reply: EditorReply | null;
  pending: boolean;
  error: unknown;
  shots: readonly DirectorShot[];
  media: Map<DirectorTakeId, MediaState>;
  onSend: (request: { text: string } | Spoken) => void;
  /** The microphone opened: the preview's sound gets out of the way. */
  onListen: () => void;
  onPick: (shotIndex: number, takeId: DirectorTakeId) => void;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("director.editor.talk");
  const errorMessage = useApiErrorMessage();
  const [text, setText] = useState("");
  const voice = useVoice(onSend);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const request = text.trim();
    if (request) {
      onSend({ text: request });
      setText("");
    }
  };
  const status = voice.listening ? t("listening") : null;
  return (
    <div className="flex flex-col gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div aria-live="polite" className="flex flex-col gap-2">
        {pending ? <GeminiLoader label={t("thinking")} showLabel size="sm" /> : null}
        {reply ? (
          <Answer
            reply={reply}
            shots={shots}
            media={media}
            onPick={onPick}
            onUndo={onUndo}
            onDismiss={onDismiss}
          />
        ) : null}
        {error && !pending ? (
          <p role="alert" className="text-sm text-studio-error">
            {errorMessage(error)}
          </p>
        ) : null}
        {voice.failed ? <p className="text-sm text-studio-error">{t("noMic")}</p> : null}
        {status ? <p className="text-sm text-studio-foreground/70">{status}</p> : null}
      </div>
      <form onSubmit={submit} className="flex items-center gap-2">
        <label className="flex min-h-11 flex-1 items-center rounded-full bg-studio-foreground/10 pr-1 pl-4 focus-within:outline-2 focus-within:outline-record">
          <span className="sr-only">{t("label")}</span>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("placeholder")}
            maxLength={500}
            enterKeyHint="send"
            className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none placeholder:text-studio-foreground/50"
          />
          <button
            type="submit"
            aria-label={t("send")}
            disabled={!text.trim() || pending}
            className="flex size-10 items-center justify-center rounded-full disabled:opacity-30"
          >
            <SendHorizontal className="size-5" aria-hidden />
          </button>
        </label>
        <button
          type="button"
          aria-label={voice.listening ? t("stop") : t("talk")}
          aria-pressed={voice.listening}
          onClick={() => {
            if (voice.listening) {
              voice.stop();
            } else {
              onListen();
              void voice.start();
            }
          }}
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-full",
            voice.listening ? "bg-record text-record-foreground" : "bg-studio-foreground/15",
          )}
        >
          {voice.listening ? (
            <Square className="size-5 fill-current" aria-hidden />
          ) : (
            <Mic className="size-5" aria-hidden />
          )}
        </button>
      </form>
    </div>
  );
}
