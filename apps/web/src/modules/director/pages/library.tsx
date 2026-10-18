"use client";

import { useApiErrorMessage } from "@repo/client";
import { useDirectorLibraryQuery } from "@repo/client/api/director/library";
import type { DirectorLibrary } from "@repo/contracts/api";
import { Button } from "@repo/ui/components/button";
import { GeminiLoader, GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { DirectorGate } from "@/modules/shorts";
import { CreditDialog } from "../components/credit-dialog";
import { IndexCard } from "../components/index-card";
import { QuickStart } from "../components/quick-start";
import { TemplateCard } from "../components/template-card";
import { quickStartOf } from "../lib/library";

const GRID = "grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 xl:grid-cols-4";

/** The templates while the library loads: the grid's shape, shimmering. */
function Loading() {
  const t = useTranslations("library");
  return (
    <div className="flex flex-col gap-4">
      <GeminiLoader label={t("loading")} size="sm" className="self-start" />
      <div aria-hidden className={GRID}>
        {Array.from({ length: 6 }, (_, index) => (
          <GeminiShimmer key={index} className="aspect-9/16 rounded-2xl bg-studio-foreground/5" />
        ))}
      </div>
    </div>
  );
}

function Templates({ library }: { library: DirectorLibrary }) {
  const t = useTranslations("library");
  const { templates } = library;
  const quickStart = quickStartOf(templates);
  return (
    <section aria-labelledby="library-templates" className="flex flex-col gap-4">
      {quickStart ? <QuickStart plan={quickStart} /> : null}
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="library-templates" className="text-lg font-semibold">
          {t("templates")}
        </h2>
        <p className="text-sm text-studio-foreground/60">
          {t("count", { count: templates.length })}
        </p>
      </div>
      {templates.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-studio-foreground/20 p-8 text-center text-sm text-studio-foreground/70">
          {t("empty")}
        </p>
      ) : (
        <ul className={GRID}>
          {templates.map((plan) => (
            <li key={plan.id}>
              <TemplateCard plan={plan} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Library() {
  const t = useTranslations("library");
  const common = useTranslations("common");
  const errorMessage = useApiErrorMessage();
  const library = useDirectorLibraryQuery();
  const [creditOpen, setCreditOpen] = useState(false);
  const linkField = useRef<HTMLInputElement>(null);
  const seeds = (library.data?.templates ?? []).filter(
    (plan) => plan.source === "seed" && plan.status === "ready",
  );
  return (
    <div className="grid gap-8 pt-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-12 lg:pt-10">
      <div className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-4xl">
            {t("heading")}
          </h1>
          <p className="max-w-prose text-studio-foreground/70">{t("intro")}</p>
        </div>
        <IndexCard
          templates={library.data?.templates ?? []}
          indexUsed={library.data?.indexUsed ?? false}
          onLimit={() => setCreditOpen(true)}
          inputRef={linkField}
        />
      </div>
      {library.isPending ? <Loading /> : null}
      {library.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-studio-error">
            {errorMessage(library.error)}
          </p>
          <Button variant="secondary" onClick={() => void library.refetch()}>
            {common("retry")}
          </Button>
        </div>
      ) : null}
      {library.data ? <Templates library={library.data} /> : null}
      <CreditDialog
        open={creditOpen}
        onOpenChange={setCreditOpen}
        seeds={seeds}
        finalFocus={linkField}
      />
    </div>
  );
}

/** The library: the workspace's templates to shoot, and the card to index a short of your own. */
export function LibraryPage() {
  return (
    <DirectorGate>
      <Library />
    </DirectorGate>
  );
}
