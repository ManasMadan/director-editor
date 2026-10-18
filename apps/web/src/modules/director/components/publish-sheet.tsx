"use client";

import { errorCode, useApiErrorMessage } from "@repo/client";
import { useFileDownloadUrl } from "@repo/client/api/files/download-url";
import { usePublishCopyMutation } from "@repo/client/api/publish/copy";
import { usePublishMutation } from "@repo/client/api/publish/upload";
import {
  type DirectorCut,
  PUBLISH_TITLE_MAX_LENGTH,
  type PublishCopy,
  type PublishVisibility,
  publishCopySchema,
  publishVisibilities,
  YOUTUBE_UPLOAD_SCOPE,
  youtubeTitle,
} from "@repo/contracts/api";
import { required } from "@repo/contracts/objects";
import { Button, buttonVariants } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Field, FieldDescription, FieldLabel } from "@repo/ui/components/field";
import { GeminiLoader, GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { CircleAlert, CircleCheck, Upload } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import * as z from "zod";
import { authClient } from "@/lib/auth-client";
import { hashtagsOf, hashtagsText, youtubeShortUrl } from "../lib/publish";

/** What the member settled on: the post, and who may watch it. */
type Draft = PublishCopy & { visibility: PublishVisibility };

const draftSchema = publishCopySchema.extend({ visibility: z.enum(publishVisibilities) });
const stashKey = (cut: DirectorCut) => `director.publish.${cut.id}`;

/**
 * Keeps the draft while the browser goes to Google to allow uploads to YouTube, so the
 * publish picks up where it was when it comes back (`?publish=<cut id>`).
 */
function stash(cut: DirectorCut, draft: Draft) {
  sessionStorage.setItem(stashKey(cut), JSON.stringify(draft));
}

/** The draft kept before going to Google, taken (it's used once). */
function unstash(cut: DirectorCut): Draft | null {
  const kept = sessionStorage.getItem(stashKey(cut));
  sessionStorage.removeItem(stashKey(cut));
  const parsed = draftSchema.safeParse(JSON.parse(kept ?? "null"));
  return parsed.success ? parsed.data : null;
}

/** The cut's video, to watch before publishing it; nothing while its link can't be had. */
function Preview({ cut }: { cut: DirectorCut }) {
  const t = useTranslations("director.publish");
  const downloadUrl = useFileDownloadUrl();
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    downloadUrl(cut.fileId).then(
      (download) => setUrl(download.url),
      () => setUrl(null),
    );
  }, [downloadUrl, cut.fileId]);
  if (url === undefined) {
    return <GeminiShimmer className="mx-auto aspect-9/16 w-32 rounded-xl bg-muted" />;
  }
  // Muted to start with: it's a look at the picture, and its captions are burned in. The
  // controls turn the sound on.
  return url ? (
    <video
      src={url}
      controls
      muted
      playsInline
      aria-label={t("preview", { title: cut.title })}
      className="mx-auto aspect-9/16 w-32 rounded-xl bg-black object-contain"
    />
  ) : null;
}

function VisibilityPicker({
  value,
  onChange,
}: {
  value: PublishVisibility;
  onChange: (visibility: PublishVisibility) => void;
}) {
  const t = useTranslations("director.publish.visibility");
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{t("label")}</legend>
      <div className="flex gap-2">
        {publishVisibilities.map((visibility) => (
          <Button
            key={visibility}
            type="button"
            size="sm"
            variant={visibility === value ? "default" : "outline"}
            aria-pressed={visibility === value}
            onClick={() => onChange(visibility)}
          >
            {t(visibility)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("audit")}</p>
    </fieldset>
  );
}

/** The post's fields, as Gemini drafted them (or the cut's title alone, when it couldn't). */
function DraftForm({ initial, onSubmit }: { initial: Draft; onSubmit: (draft: Draft) => void }) {
  const t = useTranslations("director.publish");
  const ids = { title: useId(), description: useId(), hashtags: useId(), credits: useId() };
  const [draft, setDraft] = useState(initial);
  const [hashtags, setHashtags] = useState(hashtagsText(initial.hashtags));
  const [invalid, setInvalid] = useState(false);
  const set = (field: keyof PublishCopy) => (event: { target: { value: string } }) =>
    setDraft({ ...draft, [field]: event.target.value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = draftSchema.safeParse({ ...draft, hashtags: hashtagsOf(hashtags) });
    setInvalid(!parsed.success);
    if (parsed.success) {
      onSubmit(parsed.data);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field>
        <FieldLabel htmlFor={ids.title}>{t("fields.title")}</FieldLabel>
        <Input
          id={ids.title}
          value={draft.title}
          maxLength={PUBLISH_TITLE_MAX_LENGTH}
          onChange={set("title")}
        />
        <FieldDescription>
          {t("fields.titleHint", { title: youtubeTitle(draft.title) })}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={ids.description}>{t("fields.description")}</FieldLabel>
        <Textarea id={ids.description} value={draft.description} onChange={set("description")} />
      </Field>
      <Field>
        <FieldLabel htmlFor={ids.hashtags}>{t("fields.hashtags")}</FieldLabel>
        <Input
          id={ids.hashtags}
          value={hashtags}
          onChange={(event) => setHashtags(event.target.value)}
        />
        <FieldDescription>{t("fields.hashtagsHint")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={ids.credits}>{t("fields.credits")}</FieldLabel>
        <Textarea id={ids.credits} value={draft.credits} onChange={set("credits")} />
      </Field>
      <VisibilityPicker
        value={draft.visibility}
        onChange={(visibility) => setDraft({ ...draft, visibility })}
      />
      {invalid ? (
        <p role="alert" className="text-sm text-destructive">
          {t("invalid")}
        </p>
      ) : null}
      <Button type="submit">
        <Upload className="size-4" aria-hidden />
        {t("submit")}
      </Button>
    </form>
  );
}

/** Where the cut went: on YouTube, with the privacy YouTube actually gave it. */
function Published({ cut, asked }: { cut: DirectorCut; asked: PublishVisibility }) {
  const t = useTranslations("director.publish");
  const visibility = required(cut.publish.visibility, "a published cut's visibility");
  const youtubeVideoId = required(cut.publish.youtubeVideoId, "a published cut's video");
  return (
    <div className="flex flex-col items-start gap-3" aria-live="polite">
      <p className="flex items-center gap-2 font-medium">
        <CircleCheck className="size-5 text-guide" aria-hidden />
        {t("published", { visibility })}
      </p>
      {visibility !== asked ? <p className="text-sm">{t("kept", { asked })}</p> : null}
      <a
        href={youtubeShortUrl(youtubeVideoId)}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: "outline" })}
      >
        {t("watch")}
      </a>
    </div>
  );
}

/**
 * Gemini's draft of the post when the sheet opens, or the draft kept while the member
 * was at Google allowing uploads (`resumed`), which is published again at once.
 */
function useDraft(cut: DirectorCut, resumed: Draft | null) {
  const copy = usePublishCopyMutation();
  const asked = useRef(false);
  useEffect(() => {
    if (!resumed && !asked.current) {
      asked.current = true;
      copy.mutate({ cutId: cut.id });
    }
  }, [copy, cut.id, resumed]);
  if (resumed) {
    return { draft: resumed, failed: false };
  }
  const fallback: Draft = {
    title: cut.title.slice(0, PUBLISH_TITLE_MAX_LENGTH),
    description: "",
    hashtags: [],
    credits: "",
    visibility: "unlisted",
  };
  if (copy.data) {
    return { draft: { ...copy.data, visibility: "unlisted" as const }, failed: false };
  }
  return copy.isError ? { draft: fallback, failed: true } : { draft: null, failed: false };
}

function PublishBody({ cut, resumed }: { cut: DirectorCut; resumed: Draft | null }) {
  const t = useTranslations("director.publish");
  const errorMessage = useApiErrorMessage();
  const publish = usePublishMutation();
  const { draft, failed } = useDraft(cut, resumed);
  const [asked, setAsked] = useState<PublishVisibility>("unlisted");
  const send = (chosen: Draft, { again }: { again: boolean }) => {
    setAsked(chosen.visibility);
    publish.mutate(
      { cutId: cut.id, ...chosen },
      {
        onError: (error) => {
          if (errorCode(error) === "PUBLISH_NEEDS_YOUTUBE" && !again) {
            stash(cut, chosen);
            void authClient.linkSocial({
              provider: "google",
              scopes: [YOUTUBE_UPLOAD_SCOPE],
              callbackURL: `${window.location.pathname}?publish=${cut.id}`,
            });
          }
        },
      },
    );
  };
  const sentAgain = useRef(false);
  useEffect(() => {
    if (resumed && !sentAgain.current) {
      sentAgain.current = true;
      send(resumed, { again: true });
    }
  });
  if (publish.isSuccess) {
    return <Published cut={publish.data} asked={asked} />;
  }
  if (publish.isPending) {
    return <GeminiLoader label={t("uploading")} showLabel className="py-6" />;
  }
  if (!draft) {
    return <GeminiLoader label={t("writing")} showLabel className="py-6" />;
  }
  return (
    <div className="flex flex-col gap-4">
      {failed ? <p className="text-sm text-muted-foreground">{t("copyFailed")}</p> : null}
      {publish.isError ? (
        <p role="alert" className="flex gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {errorMessage(publish.error)}
        </p>
      ) : null}
      <DraftForm initial={draft} onSubmit={(chosen) => send(chosen, { again: false })} />
    </div>
  );
}

/**
 * Publish, for a cut in My media: a sheet with the video and the post Director wrote for
 * it, to edit and send to the member's YouTube channel. A published cut links to YouTube
 * instead. Back from Google with `?publish=<this cut>`, it opens again and carries on.
 */
export function PublishButton({ cut }: { cut: DirectorCut }) {
  const t = useTranslations("director.publish");
  const returning = useSearchParams().get("publish") === cut.id;
  const [resumed] = useState(() => (returning ? unstash(cut) : null));
  const [open, setOpen] = useState(returning);
  const { youtubeVideoId } = cut.publish;
  if (cut.publish.status === "published" && youtubeVideoId) {
    return (
      <a
        href={youtubeShortUrl(youtubeVideoId)}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        {t("watch")}
      </a>
    );
  }
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {t("open")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <Preview cut={cut} />
          {open ? <PublishBody cut={cut} resumed={resumed} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
