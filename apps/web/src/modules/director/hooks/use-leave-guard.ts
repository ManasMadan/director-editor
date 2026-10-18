"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Href = Parameters<ReturnType<typeof useRouter>["push"]>[0];

/**
 * Leaving the shoot without losing a take by accident. While `guarded` (a countdown, a
 * recording, a take not kept yet), ✕ and the browser's back ask first instead of leaving:
 * `halt` runs at once (the count called off, the recording stopped, so the question sits
 * over a still take), and `asking` turns on until the member picks Leave or Stay.
 *
 * The back gesture can't be cancelled, so while guarded an extra history entry for this
 * same page sits on top: back pops that one, which asks; Stay puts it back. When the take
 * is settled (kept or thrown away) the entry is taken off again, so back works as usual.
 */
export function useLeaveGuard({
  guarded,
  away,
  halt,
}: {
  guarded: boolean;
  /** Where Leave goes. */
  away: Href;
  halt: () => void;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  // Whether this page's extra history entry is on top, and a back of our own to ignore.
  const pushed = useRef(false);
  const ignoreNext = useRef(false);
  const latest = useRef({ guarded, halt });
  useEffect(() => {
    latest.current = { guarded, halt };
  });

  useEffect(() => {
    if (guarded && !pushed.current) {
      pushed.current = true;
      window.history.pushState(window.history.state, "", window.location.href);
    }
    if (!guarded && pushed.current) {
      pushed.current = false;
      ignoreNext.current = true;
      window.history.back();
    }
  }, [guarded]);

  useEffect(() => {
    const onBack = () => {
      if (ignoreNext.current) {
        ignoreNext.current = false;
        return;
      }
      if (pushed.current && latest.current.guarded) {
        pushed.current = false;
        latest.current.halt();
        setAsking(true);
      }
    };
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, []);

  /** Goes to `href`, in place of the extra entry when it's on top, so back doesn't land on it. */
  const go = (href: Href) => {
    if (pushed.current) {
      pushed.current = false;
      router.replace(href);
    } else {
      router.push(href);
    }
  };

  return {
    asking,
    /** ✕ was tapped: leave at once when nothing's at stake, else halt and ask. */
    leave: (event: { preventDefault: () => void }) => {
      if (!guarded) {
        return;
      }
      event.preventDefault();
      halt();
      setAsking(true);
    },
    stay: () => {
      setAsking(false);
      if (latest.current.guarded && !pushed.current) {
        pushed.current = true;
        window.history.pushState(window.history.state, "", window.location.href);
      }
    },
    confirm: () => {
      setAsking(false);
      go(away);
    },
    /** Moves on (a kept take): in place of the extra entry, so back doesn't land on it. */
    go,
  };
}
