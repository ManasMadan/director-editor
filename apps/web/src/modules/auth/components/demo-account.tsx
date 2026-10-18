"use client";

import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { Button } from "@repo/ui/components/button";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef } from "react";

export interface DemoAccount {
  email: string;
  password: string;
}

/**
 * Director's shared demo account on the sign-in page, when the API has one
 * (`system.info.demo`): its card, and with `?demo=1` (the landing page's "Try the demo")
 * the form filled in with it as soon as it's known, with a loader until then.
 */
export function DemoAccountOffer({ onUse }: { onUse: (demo: DemoAccount) => void }) {
  const t = useTranslations();
  const { data: system, isPending } = useSystemInfoQuery();
  const wanted = useSearchParams().get("demo") === "1";
  const demo = system?.demo ?? null;
  // Once: a later refetch of system.info mustn't overwrite what the person typed since.
  const filled = useRef(false);
  useEffect(() => {
    if (wanted && demo && !filled.current) {
      filled.current = true;
      onUse(demo);
    }
  }, [wanted, demo, onUse]);

  if (wanted && isPending) {
    return <GeminiLoader label={t("auth.demo.loading")} showLabel size="sm" className="mx-auto" />;
  }
  return demo ? <DemoAccountCard demo={demo} onUse={() => onUse(demo)} /> : null;
}

/** The demo account's email and password in plain sight, and a button that uses them. */
function DemoAccountCard({ demo, onUse }: { demo: DemoAccount; onUse: () => void }) {
  const t = useTranslations();
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/40 p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="font-medium text-sm">
          {t("auth.demo.title")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("auth.demo.description")}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("common.email")}</dt>
        <dd className="break-all font-mono">{demo.email}</dd>
        <dt className="text-muted-foreground">{t("common.password")}</dt>
        <dd className="break-all font-mono">{demo.password}</dd>
      </dl>
      <Button type="button" variant="secondary" onClick={onUse}>
        {t("auth.demo.use")}
      </Button>
    </section>
  );
}
