"use client";

import type { Shot } from "@repo/contracts/api";
import { useLocale, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type Cue,
  cuesFor,
  heard,
  type Log,
  logged,
  type Mood,
  type Perception,
  pick,
  QUIET_LOG,
  type Words,
} from "../lib/cues";
import { favouriteThing, type Memory, usualLight } from "../lib/memory";
import { hush, onSaying, say, saying } from "../lib/speech";

/** How often Director reconsiders when nothing on screen changes (cooldowns run out). */
const TICK_MS = 400;
/** Announcements (Cut!, Back to one) outrank every cue. */
const ANNOUNCEMENT = 30;

export interface Line {
  text: string;
  mood: Mood;
  /** Bumped for each new line, so the caption can animate even when the text repeats. */
  key: number;
}

/** The session's opening line: about last time when there was one, else a first hello. */
function useGreeting(memory: Memory, shot: Shot, index: number) {
  const t = useTranslations("director.live");
  const values = { title: shot.title, scene: shot.scene };
  if (index > 0) {
    return t("say.next", values);
  }
  if (memory.sessions === 0) {
    return t("say.first", values);
  }
  const light = usualLight(memory);
  if (light) {
    const problem = { "too-dark": "dark", "too-bright": "bright", backlit: "behind" }[light];
    return t("say.backLight", { problem, title: shot.title });
  }
  const thing = favouriteThing(memory);
  return thing
    ? t("say.backThing", { thing: t(`thing.${thing}`), title: shot.title })
    : t("say.back", values);
}

/** Every line Director can say, in the member's language. */
function useWords(greeting: string): Words {
  const t = useTranslations("director.live.say");
  const live = useTranslations("director.live");
  const shoot = useTranslations("director.shoot");
  return useMemo(
    () => ({
      greeting,
      offline: t("offline"),
      ready: t("ready"),
      inPlace: t("inPlace"),
      matched: t("matched"),
      match: t("match"),
      action: t("action"),
      count: (seconds) => t("count", { seconds }),
      rolling: (seconds) => t("rolling", { seconds }),
      light: {
        "too-dark": t("light.too-dark"),
        "too-bright": t("light.too-bright"),
        backlit: t("light.backlit"),
      },
      framing: {
        "not-seen": shoot("framing.not-seen"),
        "come-closer": shoot("framing.come-closer"),
        "step-back": shoot("framing.step-back"),
        "step-left": shoot("framing.step-left"),
        "step-right": shoot("framing.step-right"),
        "aim-left": shoot("framing.aim-left"),
        "aim-right": shoot("framing.aim-right"),
      },
      angle: {
        tipUp: shoot("level.tipUp"),
        tipDown: shoot("level.tipDown"),
        leanLeft: shoot("level.leanLeft"),
        leanRight: shoot("level.leanRight"),
      },
      thing: (seen) => t("thing", { role: seen.role, thing: live(`thing.${seen.thing}`) }),
    }),
    [greeting, t, live, shoot],
  );
}

/** Whether Director is speaking right now (for the glow and the Live pill). */
export function useSpeaking() {
  // On a server nothing is being said, which `saying` already answers.
  return useSyncExternalStore(onSaying, saying, saying) !== null;
}

/**
 * Director, live on set: from what everything perceives (`perception`), the one line to
 * say now (lib/cues.ts), shown as the caption and, when `speak` is on, said aloud. Set
 * calls ("Cut!", "Back to one") go through `announce`; when the member talks, `interrupt`
 * stops Director and gives them the floor.
 */
export function useLiveDirector({
  perception,
  speak,
  memory,
  shot,
  index,
}: {
  perception: Perception;
  speak: boolean;
  memory: Memory;
  shot: Shot;
  index: number;
}) {
  const locale = useLocale();
  const words = useWords(useGreeting(memory, shot, index));
  const log = useRef<Log>(QUIET_LOG);
  const counter = useRef(0);
  const [line, setLine] = useState<Line | null>(null);
  const cues = useRef<Cue[]>([]);
  const voiced = useRef(speak);
  const offered = cuesFor(perception, words);
  useLayoutEffect(() => {
    cues.current = offered;
    voiced.current = speak;
  });

  const deliver = useCallback(
    (text: string, mood: Mood) => {
      counter.current += 1;
      setLine({ text, mood, key: counter.current });
      if (voiced.current) {
        say(text, locale);
      }
    },
    [locale],
  );

  const tick = useCallback(() => {
    const now = performance.now() / 1000;
    const next = pick(cues.current, log.current, now);
    if (next) {
      log.current = logged(log.current, next, now);
      deliver(next.text, next.mood);
    }
  }, [deliver]);

  // Every change in what Director perceives is a chance to speak, at once.
  useEffect(tick);
  useEffect(() => {
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [tick]);
  useEffect(() => () => hush(), []);
  useEffect(() => {
    if (!speak) {
      hush();
    }
  }, [speak]);

  const announce = useCallback(
    (text: string, mood: Mood = "cheer") => {
      const now = performance.now() / 1000;
      const said = {
        id: `announce:${counter.current}`,
        text,
        priority: ANNOUNCEMENT,
        mood,
        cooldown: 0,
      };
      log.current = logged(log.current, said, now);
      deliver(text, mood);
    },
    [deliver],
  );
  const interrupt = useCallback(() => {
    hush();
    log.current = heard(log.current, performance.now() / 1000);
  }, []);
  const repeat = useCallback(() => {
    if (line) {
      hush();
      deliver(line.text, line.mood);
    }
  }, [line, deliver]);

  return { line, announce, interrupt, repeat };
}
