"use client";

import { useEffect, useRef, useState } from "react";
import { isClear, isEcho } from "../lib/intents";
import { saying } from "../lib/speech";

export type ListenState = "off" | "unsupported" | "blocked" | "listening";

/** A pause before listening again once the recogniser stops by itself (it does, on silence). */
const RESTART_MS = 300;

const recognizerClass = () =>
  typeof window === "undefined"
    ? undefined
    : (window.SpeechRecognition ?? window.webkitSpeechRecognition);

interface Heard {
  /** The member said something final: what, and how sure the recogniser is. */
  onPhrase: (text: string, confidence: number) => void;
  /** The member started talking (not Director's echo): Director should stop and listen. */
  onInterrupt: () => void;
}

/** What one recognition event adds: words still being heard, and finished phrases. */
function readResults(event: SpeechRecognitionEvent) {
  let interim = "";
  const finals: { text: string; confidence: number }[] = [];
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const best = result?.[0];
    if (!(result && best)) {
      continue;
    }
    if (result.isFinal) {
      finals.push({ text: best.transcript, confidence: best.confidence });
    } else {
      interim += best.transcript;
    }
  }
  return { interim: interim.trim(), finals };
}

/**
 * Director listening, while `enabled`, in the member's language: phrases go to
 * `onPhrase`, and talking over Director interrupts it. What the microphone picks up of
 * Director's own voice, and noise the recogniser isn't sure of, is ignored (lib/intents).
 * Where the browser has no recogniser it says so ("unsupported"), and the buttons still
 * work.
 */
export function useListening(enabled: boolean, locale: string, heard: Heard) {
  const [state, setState] = useState<ListenState>(() =>
    recognizerClass() ? "off" : "unsupported",
  );
  const [words, setWords] = useState("");
  const latest = useRef(heard);
  useEffect(() => {
    latest.current = heard;
  });

  useEffect(() => {
    const Recognition = recognizerClass();
    if (!(enabled && Recognition)) {
      setState(Recognition ? "off" : "unsupported");
      return;
    }
    let stopped = false;
    let restart = 0;
    const recognizer = new Recognition();
    recognizer.lang = locale;
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.onresult = (event) => {
      const { interim, finals } = readResults(event);
      if (interim && isClear(interim, 0) && !isEcho(interim, saying())) {
        setWords(interim);
        latest.current.onInterrupt();
      }
      for (const phrase of finals) {
        if (isClear(phrase.text, phrase.confidence) && !isEcho(phrase.text, saying())) {
          setWords(phrase.text.trim());
          latest.current.onPhrase(phrase.text, phrase.confidence);
        }
      }
    };
    recognizer.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        stopped = true;
        setState("blocked");
      }
    };
    recognizer.onend = () => {
      if (!stopped) {
        restart = window.setTimeout(() => recognizer.start(), RESTART_MS);
      }
    };
    recognizer.start();
    setState("listening");
    return () => {
      stopped = true;
      window.clearTimeout(restart);
      recognizer.abort();
    };
  }, [enabled, locale]);

  return { state, words, clear: () => setWords("") };
}
