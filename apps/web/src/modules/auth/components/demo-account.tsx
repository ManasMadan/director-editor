"use client";

import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { GUEST_SIGN_IN_PATH } from "@repo/client/auth";
import { Button } from "@repo/ui/components/button";
import { GeminiLoader, GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useCaptcha } from "@/components/captcha";
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
  if (isPending) {
    return <DemoRoom />;
  }
  const shared = system?.demo ?? null;
  if (system?.features.demoGuests) {
    return <GuestOffer shared={shared} wanted={wanted} onUse={onUse} onSignedIn={onSignedIn} />;
  }
  return shared ? (
    <SharedOffer demo={shared} wanted={wanted} onUse={onUse} onSignedIn={onSignedIn} />
  ) : null;
}

/**
 * The demo card's room, shimmering, while it isn't known yet which demo there is: the
 * form under it would otherwise jump down when the card appears, under the thumb of
 * someone already typing their email. Sized by the guest card itself, drawn unseen.
 */
function DemoRoom() {
  const t = useTranslations();
  return (
    <div aria-hidden data-testid="demo-room" className="relative">
      <div inert className="invisible">
        <DemoCard
          title={t("auth.demo.guestTitle")}
          description={t("auth.demo.guestDescription")}
          action={t("auth.demo.start")}
          disabled
          onAction={() => undefined}
        />
      </div>
      <GeminiShimmer className="absolute inset-0 rounded-lg" />
    </div>
  );
}

/**
 * The sign-in as a guest: not tried yet, under way, refused (with why), or impossible for
 * now because the captcha can't give the token it needs.
 */
type GuestState =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "failed"; error: unknown }
  | { state: "unavailable" };

function GuestOffer({
  shared,
  wanted,
  onUse,
  onSignedIn,
}: DemoProps & { shared: DemoAccount | null; wanted: boolean }) {
  const errorMessage = useAuthErrorMessage();
  // Turnstile, while the API has captcha on: out of sight unless Cloudflare wants a tap,
  // so the demo is still one tap for a person, and none for a bot. With a shared account to
  // fall back on, the fallback's own notice is the one thing said when the check stalls.
  const captcha = useCaptcha({ interactionOnly: true, alert: shared === null });
  const [guest, setGuest] = useState<GuestState>({ state: wanted ? "starting" : "idle" });
  const start = async () => {
    setGuest({ state: "starting" });
    const { error } = await authClient.$fetch(GUEST_SIGN_IN_PATH, {
      method: "POST",
      body: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      headers: captcha.headers(),
    });
    if (!error) {
      onSignedIn();
      return;
    }
    // Its token is spent: a try again needs a fresh one.
    captcha.reset();
    setGuest({ state: "failed", error });
    if (shared) {
      onUse(shared);
    }
  };
  // Once, as soon as the captcha (if any) has its token: React may run the effect twice,
  // and each run would make a guest.
  const started = useRef(false);
  useEffect(() => {
    if (wanted && captcha.ready && !started.current) {
      started.current = true;
      void start();
    }
  });
  // No token to be had (Turnstile blocked, or Cloudflare not answering): no dead end, the
  // shared account takes over as it does when the sign-in itself fails.
  useEffect(() => {
    if (captcha.unavailable && !started.current) {
      started.current = true;
      setGuest({ state: "unavailable" });
      if (shared) {
        onUse(shared);
      }
    }
  });

  return (
    // The widget stays put while the rest changes, so it keeps its token.
    <div className="flex flex-col gap-3">
      <GuestCard
        guest={guest}
        shared={shared}
        ready={captcha.ready}
        error={guest.state === "failed" ? errorMessage(guest.error) : null}
        onStart={() => void start()}
        onSignedIn={onSignedIn}
      />
      {captcha.widget}
    </div>
  );
}

/** What the guest sign-in shows: a loader while it's under way, else its card. */
function GuestCard({
  guest,
  shared,
  ready,
  error,
  onStart,
  onSignedIn,
}: Pick<DemoProps, "onSignedIn"> & {
  guest: GuestState;
  shared: DemoAccount | null;
  ready: boolean;
  error: string | null;
  onStart: () => void;
}) {
  const t = useTranslations();
  if (guest.state === "starting") {
    return (
      <GeminiLoader label={t("auth.demo.signingIn")} showLabel size="sm" className="mx-auto" />
    );
  }
  if ((guest.state === "failed" || guest.state === "unavailable") && shared) {
    return (
      <>
        <p role="alert" className="text-sm">
          {t("auth.demo.fallback")}
        </p>
        <DemoAccountCard demo={shared} onSignedIn={onSignedIn} />
      </>
    );
  }
  return (
    <DemoCard
      title={t("auth.demo.guestTitle")}
      description={t("auth.demo.guestDescription")}
      action={t("auth.demo.start")}
      disabled={!ready}
      onAction={onStart}
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
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
  onSignedIn,
}: DemoProps & { demo: DemoAccount; wanted: boolean }) {
  // Once: a later refetch of system.info mustn't overwrite what the person typed since.
  const filled = useRef(false);
  useEffect(() => {
    if (wanted && !filled.current) {
      filled.current = true;
      onUse(demo);
    }
  }, [wanted, demo, onUse]);
  return <DemoAccountCard demo={demo} onSignedIn={onSignedIn} />;
}

/**
 * The demo account's email and password in plain sight, and a button that signs in with
 * them in one tap (they're in the form too, for whoever would rather press Sign in).
 */
function DemoAccountCard({ demo, onSignedIn }: { demo: DemoAccount; onSignedIn: () => void }) {
  const t = useTranslations();
  const errorMessage = useAuthErrorMessage();
  const [state, setState] = useState<{ busy: boolean; error: unknown }>({
    busy: false,
    error: null,
  });
  const signIn = async () => {
    setState({ busy: true, error: null });
    const { error } = await authClient.signIn.email(demo);
    if (!error) {
      onSignedIn();
      return;
    }
    setState({ busy: false, error });
  };
  return (
    <DemoCard
      title={t("auth.demo.title")}
      description={t("auth.demo.description")}
      action={t("auth.demo.use")}
      disabled={state.busy}
      onAction={() => void signIn()}
    >
      {/* Each value on a line of its own: side by side, the email broke mid-word on a phone. */}
      <dl className="flex flex-col gap-1 text-sm">
        <dt className="text-muted-foreground">{t("common.email")}</dt>
        <dd className="font-mono [overflow-wrap:anywhere]">{demo.email}</dd>
        <dt className="text-muted-foreground">{t("common.password")}</dt>
        <dd className="font-mono [overflow-wrap:anywhere]">{demo.password}</dd>
      </dl>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(state.error)}
        </p>
      ) : null}
    </DemoCard>
  );
}

/** The demo's card: what it is, anything it has to show, and its one button. */
function DemoCard({
  title,
  description,
  action,
  onAction,
  disabled = false,
  children,
}: {
  title: string;
  description: string;
  action: string;
  onAction: () => void;
  /** Until the button can do anything (the captcha has no token yet). */
  disabled?: boolean;
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
      <Button type="button" variant="secondary" disabled={disabled} onClick={onAction}>
        {action}
      </Button>
    </section>
  );
}
