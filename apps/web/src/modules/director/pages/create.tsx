"use client";

import { useApiErrorMessage } from "@repo/client";
import { useBrainstormMutation } from "@repo/client/api/director/brainstorm";
import { useCreateTemplateMutation } from "@repo/client/api/director/create-template";
import {
  type BriefTurn,
  DIRECTOR_BRIEF_MAX_LENGTH,
  DIRECTOR_MAX_BRIEF_TURNS,
} from "@repo/contracts/api";
import { Button } from "@repo/ui/components/button";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { cn } from "@repo/ui/lib/utils";
import { ArrowLeft, Mic, MicOff, SendHorizontal, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { DirectorGate } from "@/modules/shorts";
import { type BriefPhoto, BriefPhotos } from "../components/brief-photos";
import { useDictation } from "../hooks/use-dictation";

// The member's answer to a question: as long as a turn may be.
const ANSWER_MAX_LENGTH = 500;

function Header() {
  const t = useTranslations("create");
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 bg-studio/95 px-4 py-3 backdrop-blur">
      <Link
        href="/library"
        aria-label={t("back")}
        className="flex size-11 items-center justify-center rounded-full hover:bg-studio-foreground/10"
      >
        <ArrowLeft className="size-5" aria-hidden />
      </Link>
      <h1 className="font-semibold">{t("title")}</h1>
    </header>
  );
}

/** A mic button that says a message into `onText` instead of typing it, where it can. */
function Dictate({ onText }: { onText: (text: string) => void }) {
  const t = useTranslations("create");
  const dictation = useDictation(onText);
  if (!dictation.supported) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className="size-11 shrink-0 rounded-full"
      aria-label={dictation.listening ? t("stopDictating") : t("dictate")}
      aria-pressed={dictation.listening}
      onClick={dictation.listening ? dictation.stop : dictation.start}
    >
      {dictation.listening ? (
        <MicOff className="size-5 text-record" aria-hidden />
      ) : (
        <Mic className="size-5" aria-hidden />
      )}
    </Button>
  );
}

/** Director's questions and the member's answers, newest at the bottom. */
function Conversation({ messages, thinking }: { messages: BriefTurn[]; thinking: boolean }) {
  const t = useTranslations("create");
  return (
    <section aria-label={t("conversation")} className="flex flex-col gap-3">
      <ol aria-live="polite" className="flex flex-col gap-3">
        {messages.map((turn, index) => (
          <li
            // A turn is never edited or removed: its place is its identity.
            key={index}
            className={cn(
              "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
              turn.role === "director"
                ? "self-start bg-studio-foreground/10"
                : "self-end bg-studio-foreground text-studio",
            )}
          >
            <span className="sr-only">{turn.role === "director" ? t("director") : t("you")}: </span>
            {turn.text}
          </li>
        ))}
      </ol>
      {thinking ? <GeminiLoader label={t("thinking")} size="sm" /> : null}
    </section>
  );
}

function Answer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const t = useTranslations("create");
  const [answer, setAnswer] = useState("");
  const id = useId();
  const send = () => {
    if (answer.trim()) {
      onSend(answer.trim());
      setAnswer("");
    }
  };
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t("answerLabel")}
      </label>
      <input
        id={id}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder={t("answerPlaceholder")}
        maxLength={ANSWER_MAX_LENGTH}
        disabled={disabled}
        autoComplete="off"
        className="h-11 min-w-0 flex-1 rounded-full border border-studio-foreground/20 bg-studio-foreground/5 px-4 text-sm placeholder:text-studio-foreground/45"
      />
      <Dictate onText={(text) => setAnswer((current) => `${current} ${text}`.trim())} />
      <Button
        type="submit"
        size="icon"
        className="size-11 shrink-0 rounded-full"
        disabled={disabled || !answer.trim()}
        aria-label={t("send")}
      >
        <SendHorizontal className="size-5" aria-hidden />
      </Button>
    </form>
  );
}

function Create() {
  const t = useTranslations("create");
  const errorMessage = useApiErrorMessage();
  const router = useRouter();
  const brainstorm = useBrainstormMutation();
  const create = useCreateTemplateMutation();
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<BriefPhoto[]>([]);
  const [messages, setMessages] = useState<BriefTurn[]>([]);
  const ideaId = useId();
  const uploading = photos.some((photo) => photo.fileId === null && !photo.failed);
  const brief = (turns: BriefTurn[]) => ({
    text: text.trim(),
    messages: turns,
    photos: photos.flatMap((photo) => (photo.fileId ? [photo.fileId] : [])),
  });
  const talk = (turns: BriefTurn[]) => {
    setMessages(turns);
    brainstorm.mutate(brief(turns), {
      onSuccess: (reply) => setMessages([...turns, { role: "director", text: reply.reply }]),
    });
  };
  const busy = brainstorm.isPending || create.isPending || uploading;
  const ready = brainstorm.data?.ready ?? false;
  // Room for an answer and Director's reply to it.
  const canAnswer = messages.length > 0 && messages.length < DIRECTOR_MAX_BRIEF_TURNS - 1;
  const error = brainstorm.error ?? create.error;
  return (
    <div className="flex flex-col gap-6 px-4 pt-2 pb-36">
      <h2 className="text-2xl font-semibold tracking-tight">{t("heading")}</h2>
      <div className="flex flex-col gap-2">
        <label htmlFor={ideaId} className="text-xs font-medium text-studio-foreground/80">
          {t("label")}
        </label>
        <div className="flex items-start gap-2">
          <textarea
            id={ideaId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("placeholder")}
            maxLength={DIRECTOR_BRIEF_MAX_LENGTH}
            rows={3}
            className="min-h-24 flex-1 rounded-2xl border border-studio-foreground/20 bg-studio-foreground/5 p-3 text-base placeholder:text-studio-foreground/45"
          />
          <Dictate onText={(said) => setText((current) => `${current} ${said}`.trim())} />
        </div>
      </div>
      <BriefPhotos photos={photos} onChange={setPhotos} />
      {messages.length === 0 ? (
        <Button
          variant="secondary"
          className="h-11 self-start rounded-full px-5"
          disabled={!text.trim() || busy}
          onClick={() => talk([])}
        >
          <Sparkles className="size-4" aria-hidden />
          {t("talk")}
        </Button>
      ) : (
        <Conversation messages={messages} thinking={brainstorm.isPending} />
      )}
      {canAnswer && !ready ? (
        <Answer
          disabled={busy}
          onSend={(answer) => talk([...messages, { role: "member", text: answer }])}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-studio-error">
          {errorMessage(error)}
        </p>
      ) : null}
      <div className="fixed inset-x-0 bottom-0 z-10 bg-linear-to-t from-studio via-studio/95 to-transparent px-4 pt-10 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <Button
          className="mx-auto flex h-14 w-full max-w-lg rounded-full bg-record text-lg font-bold text-record-foreground hover:bg-record/90"
          disabled={!text.trim() || busy}
          onClick={() =>
            create.mutate(brief(messages), {
              onSuccess: (plan) => router.push(`/create/${plan.videoId}`),
            })
          }
        >
          {create.isPending ? t("writing") : t("write")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Describing a template of your own: the idea in words (typed or said), a few photos,
 * a short talk with Director, then Gemini writes the shots.
 */
export function CreatePage() {
  return (
    <DirectorGate>
      <div className="mx-auto max-w-lg">
        <Header />
        <Create />
      </div>
    </DirectorGate>
  );
}
