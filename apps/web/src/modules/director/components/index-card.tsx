"use client";

import { errorCode, useApiErrorMessage } from "@repo/client";
import { useIndexShortMutation } from "@repo/client/api/director/index-short";
import { type DirectorPlan, SHORT_URL_MAX_LENGTH } from "@repo/contracts/api";
import { Button, buttonVariants } from "@repo/ui/components/button";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { Input } from "@repo/ui/components/input";
import { CircleAlert, CircleCheck, Link2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { indexStep } from "../lib/library";
import { IndexProgress } from "./index-progress";

/** The short being indexed, as far as it got: Gemini at work, ready to open, or failed. */
function Indexing({ plan, onAnother }: { plan: DirectorPlan; onAnother: () => void }) {
  const t = useTranslations("library");
  const errorMessage = useApiErrorMessage();
  const step = indexStep(plan.status, plan.stage);
  if (step === "failed") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="flex gap-2 text-sm text-studio-error">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {errorMessage({ code: plan.error ?? "DIRECTOR_ANALYSIS_FAILED" })}
        </p>
        <Button variant="secondary" onClick={onAnother}>
          {t("index.another")}
        </Button>
      </div>
    );
  }
  if (plan.status === "ready") {
    return (
      <div className="flex flex-col items-start gap-3" aria-live="polite">
        <p className="flex items-center gap-2 font-medium">
          <CircleCheck className="size-5 text-guide" aria-hidden />
          {t("stage.ready")}
        </p>
        <Link
          href={`/director/${plan.videoId}`}
          className={buttonVariants({
            className: "bg-studio-foreground text-studio hover:bg-studio-foreground/90",
          })}
        >
          {t("index.open")}
        </Link>
      </div>
    );
  }
  return <IndexProgress step={step} className="py-2" />;
}

/**
 * The link to index. Its own state: it's mounted afresh each time the card goes back to
 * asking for a link, so a new attempt starts empty.
 */
function LinkForm({
  pending,
  error,
  indexUsed,
  onSubmit,
}: {
  pending: boolean;
  error: unknown;
  indexUsed: boolean;
  onSubmit: (link: string) => void;
}) {
  const t = useTranslations("library.index");
  const errorMessage = useApiErrorMessage();
  const [link, setLink] = useState("");
  const id = useId();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(link);
      }}
    >
      <label htmlFor={id} className="text-xs font-medium text-studio-foreground/80">
        {t("label")}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
        <div className="relative flex-1">
          <Link2
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-studio-foreground/50"
            aria-hidden
          />
          <Input
            id={id}
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder={t("placeholder")}
            maxLength={SHORT_URL_MAX_LENGTH}
            inputMode="url"
            autoComplete="off"
            className="h-11 rounded-xl border-studio-foreground/20 bg-studio-foreground/5 pl-9 text-studio-foreground placeholder:text-studio-foreground/45"
            aria-invalid={error ? true : undefined}
          />
        </div>
        <Button
          type="submit"
          disabled={!link.trim() || pending}
          className="h-11 rounded-xl bg-studio-foreground px-5 text-studio hover:bg-studio-foreground/90"
        >
          {t("submit")}
        </Button>
      </div>
      {pending ? (
        <div className="flex items-center gap-2 text-sm text-studio-foreground/80">
          <GeminiLoader label={t("checking")} size="sm" />
          <span aria-hidden>{t("checking")}</span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-studio-error">
          {errorMessage(error)}
        </p>
      ) : null}
      {indexUsed ? <p className="text-xs text-studio-foreground/60">{t("used")}</p> : null}
    </form>
  );
}

/**
 * "Bring your own Short": paste a link and Gemini indexes it, the member's one short of
 * their own. A second one is refused (DIRECTOR_INDEX_LIMIT) and `onLimit` offers the
 * starter templates instead; a short already in the library just opens. While it's
 * indexed the card follows it through the library (`templates`), which the realtime
 * nudge keeps fresh.
 */
export function IndexCard({
  templates,
  indexUsed,
  onLimit,
}: {
  templates: DirectorPlan[];
  indexUsed: boolean;
  onLimit: () => void;
}) {
  const t = useTranslations("library.index");
  const router = useRouter();
  const index = useIndexShortMutation();
  const id = useId();
  const started = index.data;
  // The library's copy once it lists the short (the realtime nudge keeps it fresh), the
  // answer to indexing until then.
  const plan = started && [...templates, started].find((p) => p.videoId === started.videoId);

  const submit = (link: string) =>
    index.mutate(
      { url: link },
      {
        onSuccess: (indexed) => {
          if (indexed.status === "ready") {
            router.push(`/director/${indexed.videoId}`);
          }
        },
        onError: (error) => {
          if (errorCode(error) === "DIRECTOR_INDEX_LIMIT") {
            index.reset();
            onLimit();
          }
        },
      },
    );

  return (
    <section
      aria-labelledby={id}
      className="relative rounded-3xl bg-linear-to-br from-aurora-1 via-aurora-2 to-aurora-3 p-px"
    >
      <div className="flex flex-col gap-4 rounded-[calc(1.5rem-1px)] bg-studio p-5">
        <div className="flex flex-col gap-1.5">
          <h2 id={id} className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="size-5 text-aurora-2" aria-hidden />
            {t("title")}
          </h2>
          <p className="text-sm text-studio-foreground/70">{t("body")}</p>
        </div>
        {plan && !index.isPending ? (
          <Indexing plan={plan} onAnother={() => index.reset()} />
        ) : (
          <LinkForm
            pending={index.isPending}
            error={index.error}
            indexUsed={indexUsed}
            onSubmit={submit}
          />
        )}
      </div>
    </section>
  );
}
