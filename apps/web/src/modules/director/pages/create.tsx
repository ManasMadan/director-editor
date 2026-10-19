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
import { useEffect, useId, useState } from "react";
import * as z from "zod";
import { authClient } from "@/lib/auth-client";
import { DirectorGate } from "@/modules/shorts";
import { type BriefPhoto, BriefPhotos } from "../components/brief-photos";
import { useDictation } from "../hooks/use-dictation";
import { dropDraft, keepDraft, readDraft } from "../lib/drafts";

// The member's answer to a question: as long as a turn may be.
const ANSWER_MAX_LENGTH = 500;

/**
 * The brief as kept in this tab (lib/drafts.ts), per member: the idea and the talk so
 * far. Not the photos: their previews are this page's own copies of the files, gone with
 * a reload, so they're added again.
 */
const draftSchema = z.object({
  text: z.string().max(DIRECTOR_BRIEF_MAX_LENGTH),
  messages: z
    .array(
      z.object({
        role: z.enum(["member", "director"]),
        text: z.string().min(1).max(ANSWER_MAX_LENGTH),
      }) satisfies z.ZodType<BriefTurn>,
    )
    .max(DIRECTOR_MAX_BRIEF_TURNS),
});
type Draft = z.infer<typeof draftSchema>;
const EMPTY: Draft = { text: "", messages: [] };
const draftKey = (owner: string) => `director.create.${owner}`;

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

function Answer({
  disabled,
  answer,
  setAnswer,
  onSend,
}: {
  disabled: boolean;
  answer: string;
  setAnswer: (update: (current: string) => string) => void;
  onSend: (text: string) => void;
}) {
  const t = useTranslations("create");
  const id = useId();
  const send = () => {
    if (answer.trim()) {
      onSend(answer.trim());
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
        onChange={(event) => {
          const typed = event.target.value;
          setAnswer(() => typed);
        }}
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

/** The brief kept for `owner` in this tab, read once, and kept again as it changes. */
function useBriefDraft(owner: string | null) {
  const [draft] = useState(() => (owner ? readDraft(draftKey(owner), draftSchema) : null));
  const [text, setText] = useState((draft ?? EMPTY).text);
  const [messages, setMessages] = useState<BriefTurn[]>((draft ?? EMPTY).messages);
  useEffect(() => {
    if (owner) {
      keepDraft(draftKey(owner), { text, messages } satisfies Draft);
    }
  }, [owner, text, messages]);
  return {
    text,
    setText,
    messages,
    setMessages,
    /** The brief became a template: there's nothing left to come back to. */
    done: () => {
      if (owner) {
        dropDraft(draftKey(owner));
      }
    },
  };
}

/** The idea in the member's words, typed or said. */
function Idea({
  text,
  setText,
}: {
  text: string;
  setText: (update: (current: string) => string) => void;
}) {
  const t = useTranslations("create");
  const ideaId = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={ideaId} className="text-xs font-medium text-studio-foreground/80">
        {t("label")}
      </label>
      <div className="flex items-start gap-2">
        <textarea
          id={ideaId}
          value={text}
          onChange={(event) => {
            const typed = event.target.value;
            setText(() => typed);
          }}
          placeholder={t("placeholder")}
          maxLength={DIRECTOR_BRIEF_MAX_LENGTH}
          rows={3}
          className="min-h-24 flex-1 rounded-2xl border border-studio-foreground/20 bg-studio-foreground/5 p-3 text-base placeholder:text-studio-foreground/45"
        />
        <Dictate onText={(said) => setText((current) => `${current} ${said}`.trim())} />
      </div>
    </div>
  );
}

function Create({ owner }: { owner: string | null }) {
  const t = useTranslations("create");
  const errorMessage = useApiErrorMessage();
  const router = useRouter();
  const brainstorm = useBrainstormMutation();
  const create = useCreateTemplateMutation();
  const { text, setText, messages, setMessages, done } = useBriefDraft(owner);
  const [photos, setPhotos] = useState<BriefPhoto[]>([]);
  const [answer, setAnswer] = useState("");
  const uploading = photos.some((photo) => photo.fileId === null && !photo.failed);
  const brief = (turns: BriefTurn[]) => ({
    text: text.trim(),
    messages: turns,
    photos: photos.flatMap((photo) => (photo.fileId ? [photo.fileId] : [])),
  });
  // A turn Director couldn't answer is taken back (its words stay in the box to send
  // again): otherwise the next answer would be the member's second turn in a row.
  const talk = (turns: BriefTurn[]) => {
    const before = messages;
    setMessages(turns);
    brainstorm.mutate(brief(turns), {
      onSuccess: (reply) => {
        setMessages([...turns, { role: "director", text: reply.reply }]);
        setAnswer(() => "");
      },
      onError: () => setMessages(before),
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
      <Idea text={text} setText={setText} />
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
          answer={answer}
          setAnswer={setAnswer}
          onSend={(said) => talk([...messages, { role: "member", text: said }])}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-studio-error">
          {errorMessage(error)}
        </p>
      ) : null}
      <WriteBar
        disabled={!text.trim() || busy}
        writing={create.isPending}
        onWrite={() =>
          create.mutate(brief(messages), {
            onSuccess: (plan) => {
              done();
              router.push(`/create/${plan.videoId}`);
            },
          })
        }
      />
    </div>
  );
}

/** "Write my shots", held at the bottom of the screen. */
function WriteBar({
  disabled,
  writing,
  onWrite,
}: {
  disabled: boolean;
  writing: boolean;
  onWrite: () => void;
}) {
  const t = useTranslations("create");
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 bg-linear-to-t from-studio via-studio/95 to-transparent px-4 pt-10 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      <Button
        className="mx-auto flex h-14 w-full max-w-lg rounded-full bg-record text-lg font-bold text-record-foreground hover:bg-record/90"
        disabled={disabled}
        onClick={onWrite}
      >
        {writing ? t("writing") : t("write")}
      </Button>
    </div>
  );
}

/**
 * Describing a template of your own: the idea in words (typed or said), a few photos,
 * a short talk with Director, then Gemini writes the shots.
 */
export function CreatePage() {
  const session = authClient.useSession();
  return (
    <DirectorGate>
      <div className="mx-auto max-w-lg">
        <Header />
        {/* Whose brief it is decides which draft comes back: known before it's read. */}
        {session.isPending ? null : (
          <Create key={session.data?.user.id ?? "nobody"} owner={session.data?.user.id ?? null} />
        )}
      </div>
    </DirectorGate>
  );
}
