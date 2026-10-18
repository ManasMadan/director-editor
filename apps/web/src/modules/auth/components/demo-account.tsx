"use client";

import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { GUEST_SIGN_IN_PATH } from "@repo/client/auth";
import { Button } from "@repo/ui/components/button";
import { GeminiLoader } from "@repo/ui/components/gemini-loader";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage } from "../hooks/use-auth-error";

interface DemoAccount {
  email: string;
  password: string;
}

interface DemoProps {
  /** Puts the shared demo account's email and password in the form. */
  onUse: (demo: DemoAccount) => void;
  /** The browser is signed in (as a guest): on to the library. */
  onSignedIn: () => void;
}

/**
 * The demo on the sign-in page, as the API offers it (`system.info`):
 *
 * - with demo guests on (`features.demoGuests`), a card whose button signs this browser in
 *   as a private guest of its own, deleted after a day; `?demo=1` (the landing page's
 *   "Try it now, no sign-up") starts it at once. When no guest can be made (the demo is
 *   full, or this address made too many), the shared demo account takes over, its email
 *   and password in the form, so it's never a dead end;
 * - with only the shared account, its card, and `?demo=1` fills the form with it.
 */
export function DemoOffer({ onUse, onSignedIn }: DemoProps) {
  const t = useTranslations();
  const { data: system, isPending } = useSystemInfoQuery();
  const wanted = useSearchParams().get("demo") === "1";
  if (wanted && isPending) {
    return <GeminiLoader label={t("auth.demo.loading")} showLabel size="sm" className="mx-auto" />;
  }
  const shared = system?.demo ?? null;
  if (system?.features.demoGuests) {
    return <GuestOffer shared={shared} wanted={wanted} onUse={onUse} onSignedIn={onSignedIn} />;
  }
  return shared ? <SharedOffer demo={shared} wanted={wanted} onUse={onUse} /> : null;
}

/** The sign-in as a guest: not tried yet, under way, or refused (with why). */
type GuestState = { state: "idle" } | { state: "starting" } | { state: "failed"; error: unknown };

function GuestOffer({
  shared,
  wanted,
  onUse,
  onSignedIn,
}: DemoProps & { shared: DemoAccount | null; wanted: boolean }) {
  const t = useTranslations();
  const errorMessage = useAuthErrorMessage();
  const [guest, setGuest] = useState<GuestState>({ state: wanted ? "starting" : "idle" });
  const start = async () => {
    setGuest({ state: "starting" });
    const { error } = await authClient.$fetch(GUEST_SIGN_IN_PATH, {
      method: "POST",
      body: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    if (!error) {
      onSignedIn();
      return;
    }
    setGuest({ state: "failed", error });
    if (shared) {
      onUse(shared);
    }
  };
  // Once: React may run the effect twice, and each run would make a guest.
  const started = useRef(false);
  useEffect(() => {
    if (wanted && !started.current) {
      started.current = true;
      void start();
    }
  });

  if (guest.state === "starting") {
    return (
      <GeminiLoader label={t("auth.demo.signingIn")} showLabel size="sm" className="mx-auto" />
    );
  }
  if (guest.state === "failed" && shared) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm">
          {t("auth.demo.fallback")}
        </p>
        <DemoAccountCard demo={shared} onUse={() => onUse(shared)} />
      </div>
    );
  }
  return (
    <DemoCard
      title={t("auth.demo.guestTitle")}
      description={t("auth.demo.guestDescription")}
      action={t("auth.demo.start")}
      onAction={() => void start()}
    >
      {guest.state === "failed" ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(guest.error)}
        </p>
      ) : null}
    </DemoCard>
  );
}

/** The shared demo account, and with `?demo=1` the form filled with it once it's known. */
function SharedOffer({
  demo,
  wanted,
  onUse,
}: Pick<DemoProps, "onUse"> & { demo: DemoAccount; wanted: boolean }) {
  // Once: a later refetch of system.info mustn't overwrite what the person typed since.
  const filled = useRef(false);
  useEffect(() => {
    if (wanted && !filled.current) {
      filled.current = true;
      onUse(demo);
    }
  }, [wanted, demo, onUse]);
  return <DemoAccountCard demo={demo} onUse={() => onUse(demo)} />;
}

/** The demo account's email and password in plain sight, and a button that uses them. */
function DemoAccountCard({ demo, onUse }: { demo: DemoAccount; onUse: () => void }) {
  const t = useTranslations();
  return (
    <DemoCard
      title={t("auth.demo.title")}
      description={t("auth.demo.description")}
      action={t("auth.demo.use")}
      onAction={onUse}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("common.email")}</dt>
        <dd className="break-all font-mono">{demo.email}</dd>
        <dt className="text-muted-foreground">{t("common.password")}</dt>
        <dd className="break-all font-mono">{demo.password}</dd>
      </dl>
    </DemoCard>
  );
}

/** The demo's card: what it is, anything it has to show, and its one button. */
function DemoCard({
  title,
  description,
  action,
  onAction,
  children,
}: {
  title: string;
  description: string;
  action: string;
  onAction: () => void;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/40 p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="font-medium text-sm">
          {title}
        </h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
      <Button type="button" variant="secondary" onClick={onAction}>
        {action}
      </Button>
    </section>
  );
}
