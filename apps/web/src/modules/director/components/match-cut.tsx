"use client";

import type { MatchCutAlignment } from "@repo/contracts/api";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { Crosshair, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { MatchCutState } from "../hooks/use-match-cuts";

const jpeg = (base64: string) => `data:image/jpeg;base64,${base64}`;
const px = (value: number) => Math.round(value);

/**
 * "Check the cut" (spec 9.5): the last frame before the cut with the first after it,
 * aligned, laid over at half strength, a crosshair on the anchor, and how far it still
 * moves at the cut.
 */
function CheckTheCut({
  index,
  anchor,
  alignment,
  onClose,
}: {
  index: number;
  anchor: string;
  alignment: MatchCutAlignment;
  onClose: () => void;
}) {
  const t = useTranslations("director.matchCut");
  const { outgoingFrame, incomingFrame } = alignment;
  return (
    // Controlled and always open while shown: its only change is closing.
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-dvh max-w-sm gap-3 overflow-y-auto bg-studio text-studio-foreground">
        <DialogTitle>{t("checkTitle", { index })}</DialogTitle>
        <DialogDescription className="text-studio-foreground/70">
          {t("checkBody", { anchor })}
        </DialogDescription>
        {outgoingFrame && incomingFrame ? (
          <div className="relative mx-auto aspect-9/16 w-full max-w-64 overflow-hidden rounded-xl bg-studio-foreground/10">
            {/* Data URLs the service drew: Next's image component has nothing to optimise. */}
            <img
              src={jpeg(outgoingFrame)}
              alt={t("before")}
              className="absolute inset-0 size-full"
            />
            <img
              src={jpeg(incomingFrame)}
              alt={t("after")}
              className="absolute inset-0 size-full opacity-50"
            />
            {alignment.anchor ? (
              <Crosshair
                aria-hidden
                className="absolute size-8 -translate-x-1/2 -translate-y-1/2 text-record drop-shadow"
                style={{
                  left: `${alignment.anchor.x * 100}%`,
                  top: `${alignment.anchor.y * 100}%`,
                }}
              />
            ) : null}
          </div>
        ) : null}
        <p className="text-center text-lg font-semibold tabular-nums">
          {t("offset", { offset: px(alignment.offsetPx) })}
        </p>
        <p className="text-center text-sm text-studio-foreground/70">
          {t("tolerance", { within: String(alignment.withinTolerance) })}
        </p>
        <DialogClose className="min-h-11 rounded-full bg-record px-6 py-2 font-semibold text-record-foreground">
          {t("close")}
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

function Note({ state }: { state: MatchCutState }) {
  const t = useTranslations("director.matchCut");
  const [checking, setChecking] = useState(false);
  const { cut } = state;
  const index = cut.into + 1;
  if (state.step === "aligning") {
    return <GeminiLoader label={t("aligning", { index, anchor: cut.anchor })} showLabel />;
  }
  if (state.step === "failed" || state.alignment.status === "not-found") {
    return (
      <p className="text-xs text-studio-foreground/60">
        {state.step === "failed"
          ? t("failed", { index })
          : t("notFound", { index, anchor: cut.anchor })}
      </p>
    );
  }
  const { alignment } = state;
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-studio-foreground/10 px-3 py-2">
      <Sparkles className="size-5 shrink-0 text-record" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t("aligned")}</p>
        <p className="text-xs text-studio-foreground/70">
          {t("alignedBody", {
            anchor: cut.anchor,
            index,
            offset: px(alignment.offsetPx),
            before: px(alignment.offsetBeforePx),
          })}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setChecking(true)}
        className="min-h-11 shrink-0 rounded-full bg-studio-foreground/15 px-4 text-sm font-semibold"
      >
        {t("check")}
      </button>
      {checking ? (
        <CheckTheCut
          index={index}
          anchor={cut.anchor}
          alignment={alignment}
          onClose={() => setChecking(false)}
        />
      ) : null}
    </div>
  );
}

/** A note for each match cut in the edit: "Aligned for you", and the way to check it. */
export function MatchCutNotes({ cuts }: { cuts: readonly MatchCutState[] }) {
  if (cuts.length === 0) {
    return null;
  }
  return (
    // Announced as each cut lines up: the member doesn't have to look for it.
    <div aria-live="polite" className="flex flex-col gap-2 px-4">
      {cuts.map((state) => (
        <Note key={state.cut.into} state={state} />
      ))}
    </div>
  );
}
