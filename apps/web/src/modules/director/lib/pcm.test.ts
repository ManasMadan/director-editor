import { describe, expect, it } from "vitest";
import {
  CAPTURE_RATE,
  decodePcm16,
  downsampler,
  encodePcm16,
  fromPcm16,
  levelOf,
  toPcm16,
} from "./pcm";

/** A 440 Hz tone, `seconds` long at `rate`. */
const tone = (rate: number, seconds: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, at) =>
    Math.sin((2 * Math.PI * 440 * at) / rate),
  );

describe("the microphone's samples, brought down to 16 kHz", () => {
  it("keeps a third of a 48 kHz signal, and its level", () => {
    const down = downsampler(48_000);
    const out = down(new Float32Array(4800).fill(0.5));
    expect(out).toHaveLength(1600);
    expect(out.every((sample) => Math.abs(sample - 0.5) < 1e-6)).toBe(true);
  });

  it("gives the same samples in chunks as all at once, at an uneven ratio", () => {
    const input = tone(44_100, 0.25);
    const whole = downsampler(44_100)(input);
    const chunked = downsampler(44_100);
    const ends = [1000, 1001, 2048, 4410, input.length];
    const pieces = ends.map((end, at) => chunked(input.subarray(ends[at - 1] ?? 0, end)));
    const joined = Float32Array.from(pieces.flatMap((piece) => Array.from(piece)));
    expect(whole.length).toBe(Math.floor((input.length * CAPTURE_RATE) / 44_100));
    expect(joined).toEqual(whole);
  });

  it("passes a 16 kHz signal through as it is", () => {
    const input = tone(CAPTURE_RATE, 0.01);
    expect(downsampler(CAPTURE_RATE)(input)).toEqual(input);
  });

  it("refuses to make up samples a slower microphone never had", () => {
    expect(() => downsampler(8000)).toThrow(RangeError);
  });
});

describe("16-bit PCM", () => {
  it("scales samples to 16 bits, clipping what's out of range", () => {
    expect(Array.from(toPcm16(Float32Array.from([0, 1, -1, 0.5, 2, -3])))).toEqual([
      0, 32767, -32768, 16384, 32767, -32768,
    ]);
  });

  it("scales 16 bits back to samples", () => {
    expect(Array.from(fromPcm16(Int16Array.from([0, -32768, 16384])))).toEqual([0, -1, 0.5]);
  });

  it("goes to base64 little-endian and back", () => {
    const pcm = Int16Array.from([1, -2, 300, -32768, 32767]);
    const encoded = encodePcm16(pcm);
    // 1 as little-endian bytes is 01 00.
    expect(atob(encoded).charCodeAt(0)).toBe(1);
    expect(atob(encoded).charCodeAt(1)).toBe(0);
    expect(decodePcm16(encoded)).toEqual(pcm);
  });

  it("drops a stray byte that can't be a whole sample", () => {
    expect(decodePcm16(btoa("\u0001\u0000\u0002"))).toEqual(Int16Array.from([1]));
  });
});

describe("the voice's level, for the orb", () => {
  it("is nothing for silence, and grows with the voice up to 1", () => {
    expect(levelOf(new Float32Array(256))).toBe(0);
    const quiet = levelOf(new Float32Array(256).fill(0.05));
    const loud = levelOf(new Float32Array(256).fill(0.2));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(levelOf(new Float32Array(256).fill(1))).toBe(1);
    expect(levelOf(new Float32Array(0))).toBe(0);
  });
});
