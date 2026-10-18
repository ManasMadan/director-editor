"use client";

import { errorCode, useApiErrorMessage } from "@repo/client";
import { useEditPlanMutation } from "@repo/client/api/director/edit-plan";
import { useDirectorPlanQuery } from "@repo/client/api/director/plan";
import { DIRECTOR_MAX_SHOTS, type DirectorPlan, type ServedShotPlan } from "@repo/contracts/api";
import { Button, buttonVariants } from "@repo/ui/components/button";
import { GeminiLoader, GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { ArrowDown, ArrowLeft, ArrowUp, CircleAlert, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { DirectorGate } from "@/modules/shorts";
import { moved, newShot, type ShotDraft, shotsValid } from "../lib/created";

// A shot's longest and shortest in the edit (packages/contracts' shot schema).
const SHOT_MIN_SECONDS = 1;
const SHOT_MAX_SECONDS = 60;
const TITLE_MAX_LENGTH = 80;
const SCENE_MAX_LENGTH = 200;

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
      <h1 className="font-semibold">{t("plan.title")}</h1>
    </header>
  );
}

/** Moving a shot up or down, and deleting it. */
function ShotTools({
  index,
  count,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("create.plan");
  const number = index + 1;
  return (
    <div className="flex">
      <Button
        variant="ghost"
        size="icon"
        className="size-11"
        disabled={index === 0}
        onClick={() => onMove(-1)}
        aria-label={t("moveUp", { index: number })}
      >
        <ArrowUp className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-11"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
        aria-label={t("moveDown", { index: number })}
      >
        <ArrowDown className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-11"
        disabled={count === 1}
        onClick={onRemove}
        aria-label={t("remove", { index: number })}
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

/** A shot's card: its picture, then what happens, where and for how long. */
function ShotCard({
  shot,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  shot: ShotDraft;
  index: number;
  count: number;
  onChange: (shot: ShotDraft) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("create.plan");
  const id = useId();
  const number = index + 1;
  return (
    <li className="flex gap-3 rounded-2xl bg-studio-foreground/5 p-3">
      <div className="relative aspect-9/16 w-20 shrink-0 overflow-hidden rounded-xl bg-studio-foreground/10">
        {shot.storyboardUrl ? (
          <img
            src={shot.storyboardUrl}
            alt={t("storyboardAlt", { index: number })}
            className="size-full object-cover"
          />
        ) : (
          <GeminiShimmer className="absolute inset-0 rounded-none bg-transparent" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-studio-foreground/70">
            {t("shot", { index: number })}
          </p>
          <ShotTools index={index} count={count} onMove={onMove} onRemove={onRemove} />
        </div>
        <label htmlFor={`${id}-title`} className="text-xs text-studio-foreground/70">
          {t("shotTitle")}
        </label>
        <input
          id={`${id}-title`}
          value={shot.title}
          maxLength={TITLE_MAX_LENGTH}
          onChange={(event) => onChange({ ...shot, title: event.target.value })}
          className="h-11 rounded-xl border border-studio-foreground/20 bg-studio px-3 text-sm"
        />
        <label htmlFor={`${id}-scene`} className="text-xs text-studio-foreground/70">
          {t("scene")}
        </label>
        <textarea
          id={`${id}-scene`}
          value={shot.scene}
          maxLength={SCENE_MAX_LENGTH}
          rows={2}
          onChange={(event) => onChange({ ...shot, scene: event.target.value })}
          className="rounded-xl border border-studio-foreground/20 bg-studio p-3 text-sm"
        />
        <label htmlFor={`${id}-seconds`} className="text-xs text-studio-foreground/70">
          {t("seconds")}
        </label>
        <input
          id={`${id}-seconds`}
          type="number"
          inputMode="decimal"
          min={SHOT_MIN_SECONDS}
          max={SHOT_MAX_SECONDS}
          step={0.5}
          value={shot.durationSeconds}
          onChange={(event) => {
            const seconds = Number(event.target.value);
            if (seconds >= SHOT_MIN_SECONDS && seconds <= SHOT_MAX_SECONDS) {
              onChange({ ...shot, durationSeconds: seconds });
            }
          }}
          className="h-11 w-24 rounded-xl border border-studio-foreground/20 bg-studio px-3 text-sm"
        />
      </div>
    </li>
  );
}

/** The plan's shots to change: edit, move, delete, add; then save, or go and shoot it. */
function Editor({ plan }: { plan: DirectorPlan & { plan: ServedShotPlan } }) {
  const t = useTranslations("create.plan");
  const errorMessage = useApiErrorMessage();
  const edit = useEditPlanMutation();
  // The member's changes until they're saved; the saved plan otherwise, so storyboard
  // cards drawn meanwhile show up as they land.
  const [draft, setDraft] = useState<ShotDraft[] | null>(null);
  const shots = draft ?? plan.plan.shots;
  const dirty = draft !== null;
  const change = (next: ShotDraft[]) => setDraft(next);
  const save = () =>
    edit.mutate(
      { videoId: plan.videoId, plan: { ...plan.plan, shots } },
      { onSuccess: () => setDraft(null) },
    );
  return (
    <div className="flex flex-col gap-4 px-4 pt-2 pb-36">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">{plan.plan.title}</h2>
        <p className="text-sm text-studio-foreground/70">{plan.plan.summary}</p>
        <p className="text-sm text-studio-foreground/70">{t("intro")}</p>
      </div>
      <ol className="flex flex-col gap-3">
        {shots.map((shot, index) => (
          <ShotCard
            // Shots have no id of their own; a card's place is the shot it edits.
            key={index}
            shot={shot}
            index={index}
            count={shots.length}
            onChange={(next) => change(shots.map((each, at) => (at === index ? next : each)))}
            onMove={(by) => change(moved(shots, index, by))}
            onRemove={() => change(shots.filter((_, at) => at !== index))}
          />
        ))}
      </ol>
      {shots.length < DIRECTOR_MAX_SHOTS ? (
        <Button
          variant="secondary"
          className="h-11 self-start rounded-full px-5"
          onClick={() =>
            change([...shots, newShot(shots, { title: t("newShot"), scene: t("newScene") })])
          }
        >
          <Plus className="size-4" aria-hidden />
          {t("add")}
        </Button>
      ) : null}
      {edit.error ? (
        <p role="alert" className="text-sm text-studio-error">
          {errorMessage(edit.error)}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {edit.isSuccess && !dirty ? t("saved") : ""}
      </p>
      <div className="fixed inset-x-0 bottom-0 z-10 bg-linear-to-t from-studio via-studio/95 to-transparent px-4 pt-10 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {dirty ? (
          <Button
            className="mx-auto flex h-14 w-full max-w-lg rounded-full text-lg font-bold"
            disabled={edit.isPending || !shotsValid(shots)}
            onClick={save}
          >
            {edit.isPending ? t("saving") : t("save")}
          </Button>
        ) : (
          <Link
            href={`/director/${plan.videoId}`}
            className="mx-auto flex w-full max-w-lg items-center justify-center gap-2.5 rounded-full bg-record py-4 text-lg font-bold text-record-foreground shadow-xl"
          >
            <span className="size-3.5 rounded-full bg-record-foreground" aria-hidden />
            {t("shoot")}
          </Link>
        )}
      </div>
    </div>
  );
}

/** Before the shots are written: Director at work, or why it couldn't write them. */
function Waiting({ plan, error }: { plan: DirectorPlan | undefined; error: unknown }) {
  const t = useTranslations("create.plan");
  const stage = useTranslations("library.stage");
  const errorMessage = useApiErrorMessage();
  if (error || plan?.status === "failed") {
    const code = plan?.error ?? "DIRECTOR_CREATE_FAILED";
    return (
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <CircleAlert className="size-8 text-studio-error" aria-hidden />
        <p role="alert" className="font-medium text-studio-error">
          {error ? errorMessage(error) : errorMessage({ code })}
        </p>
        {errorCode(error) === "DIRECTOR_PLAN_NOT_FOUND" ? null : (
          <p className="max-w-sm text-sm text-studio-foreground/70">{t("failedHelp")}</p>
        )}
        <Link href="/create" className={buttonVariants({ variant: "secondary" })}>
          {t("again")}
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4 p-12 text-center">
      <GeminiLoader label={stage("writingCreated")} size="lg" />
      <p aria-hidden className="font-medium">
        {stage("writingCreated")}
      </p>
      <p className="max-w-xs text-sm text-studio-foreground/60">{stage("hint")}</p>
    </div>
  );
}

function Created({ videoId }: { videoId: string }) {
  const plan = useDirectorPlanQuery(videoId);
  const current = plan.data;
  if (current?.status === "ready" && current.plan) {
    return <Editor plan={{ ...current, plan: current.plan }} />;
  }
  return <Waiting plan={current} error={plan.error} />;
}

/** A template the member described: Director writing it, then its shots to change. */
export function CreatedPage({ videoId }: { videoId: string }) {
  return (
    <DirectorGate>
      <div className="mx-auto max-w-lg">
        <Header />
        <Created videoId={videoId} />
      </div>
    </DirectorGate>
  );
}
