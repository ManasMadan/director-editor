"use client";

import { Button } from "@repo/ui/components/button";
import { Spinner } from "@repo/ui/components/spinner";
import { useTranslations } from "next-intl";
import type { Phase } from "../hooks/use-studio";
import { RecordButton } from "./record-button";

/** The camera screen's bottom: record or shoot, stop, then keep or redo the take. */
export function CaptureBar({
  phase,
  kind,
  ready,
  error,
  onRecord,
  onStop,
  onRetake,
  onUse,
}: {
  phase: Phase;
  kind: "video" | "photo";
  ready: boolean;
  error: string | null;
  onRecord: () => void;
  onStop: () => void;
  onRetake: () => void;
  onUse: () => void;
}) {
  const t = useTranslations("director");
  if (phase === "preview" || phase === "sending") {
    return (
      <div className="flex flex-col items-center gap-3">
        {error ? (
          <p role="alert" className="rounded-xl bg-studio/80 px-3 py-2 text-sm text-studio-error">
            {error}
          </p>
        ) : null}
        <div className="flex gap-3">
          <Button variant="secondary" size="lg" onClick={onRetake} disabled={phase === "sending"}>
            {t("shoot.retake")}
          </Button>
          {/* Light on the dark stage in both themes (the default button is dark in light). */}
          <Button
            size="lg"
            onClick={onUse}
            disabled={phase === "sending"}
            className="bg-studio-foreground text-studio hover:bg-studio-foreground/90"
          >
            {phase === "sending" ? <Spinner /> : null}
            {phase === "sending" ? t("shoot.sending") : t("shoot.use")}
          </Button>
        </div>
      </div>
    );
  }
  if (phase === "recording") {
    return <RecordButton label={t("shoot.stop")} mode="stop" onClick={onStop} />;
  }
  return (
    <div className="flex flex-col items-center gap-3">
      {error ? (
        <p role="alert" className="rounded-xl bg-studio/80 px-3 py-2 text-sm text-studio-error">
          {error}
        </p>
      ) : null}
      <RecordButton
        label={kind === "photo" ? t("shoot.photo") : t("record")}
        mode={kind === "photo" ? "photo" : "record"}
        onClick={onRecord}
        disabled={!ready || phase === "countdown"}
      />
    </div>
  );
}
