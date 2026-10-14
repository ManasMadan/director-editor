"use client";

import { SECOND_MS } from "@repo/contracts/time";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { Sample } from "../lib/cut";
import {
  difference,
  type Light,
  lightOf,
  lumaOf,
  NEW_PLACE,
  SAMPLE_HEIGHT,
  SAMPLE_WIDTH,
  SHAKY,
  steadyReading,
} from "../lib/frame-stats";
import { viewCrop } from "../lib/view";

/** Four looks a second: quick enough to feel instant, nothing for a phone to do. */
const EVERY_MS = SECOND_MS / 4;
/** A light reading must hold for this many looks (about a second) before Director says so. */
const LIGHT_HOLDS = 4;

/** The voice's level now (RMS), from the camera stream's microphone, or null without one. */
function loudnessMeter(stream: MediaStream | null) {
  if (!stream || stream.getAudioTracks().length === 0 || typeof AudioContext === "undefined") {
    return { read: () => null, close: () => undefined };
  }
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  return {
    read: () => {
      if (context.state !== "running") {
        return null;
      }
      analyser.getFloatTimeDomainData(buffer);
      return Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length);
    },
    close: () => void context.close(),
  };
}

/** A tiny copy of what the viewfinder shows, as brightness per pixel. */
function sampler() {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return (video: HTMLVideoElement) => {
    if (!context || video.readyState < 2 || video.videoWidth === 0) {
      return null;
    }
    const crop = viewCrop(video.videoWidth, video.videoHeight);
    context.drawImage(
      video,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      SAMPLE_WIDTH,
      SAMPLE_HEIGHT,
    );
    return lumaOf(context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data);
  };
}

/** Successive looks compared: the motion since the last, the light, and a new place. */
function reader() {
  const steadyLight = steadyReading<Light>(LIGHT_HOLDS);
  let previous: Float32Array | null = null;
  let anchor: Float32Array | null = null;
  return (luma: Float32Array) => {
    const motion = previous ? difference(previous, luma) : 0;
    previous = luma;
    const moved = !anchor || difference(anchor, luma) > NEW_PLACE;
    if (moved) {
      anchor = luma;
    }
    const now = lightOf(luma);
    return { motion, now, light: steadyLight(now), moved };
  };
}

/**
 * What the phone sees for itself, while `active`: the light, whether the camera is
 * shaking, and a count that goes up each time it's pointed somewhere new (so Director can
 * look again at once instead of waiting for its next check). While `recording`, every
 * look is logged with the voice's level for the Director's Cut (`take()`).
 */
export function useVision(
  video: RefObject<HTMLVideoElement | null>,
  stream: MediaStream | null,
  { active, recording }: { active: boolean; recording: boolean },
) {
  const [light, setLight] = useState<Light | null>(null);
  const [shaky, setShaky] = useState(false);
  const [moved, setMoved] = useState(0);
  const log = useRef<Sample[]>([]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const sample = sampler();
    const read = reader();
    const meter = recording ? loudnessMeter(stream) : null;
    const begun = performance.now();
    if (recording) {
      log.current = [];
    }
    const look = () => {
      const element = video.current;
      const luma = element && !document.hidden ? sample(element) : null;
      if (!luma) {
        return;
      }
      const reading = read(luma);
      setLight(reading.light);
      setShaky(reading.motion > SHAKY);
      if (reading.moved) {
        setMoved((count) => count + 1);
      }
      if (meter) {
        const seconds = (performance.now() - begun) / SECOND_MS;
        log.current.push({
          seconds,
          motion: reading.motion,
          light: reading.now,
          loudness: meter.read(),
        });
      }
    };
    const timer = window.setInterval(look, EVERY_MS);
    return () => {
      window.clearInterval(timer);
      meter?.close();
    };
  }, [active, recording, video, stream]);

  return { light, shaky, moved, take: () => log.current };
}
