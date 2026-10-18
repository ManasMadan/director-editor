/**
 * The call's audio as the Live API speaks it: 16-bit little-endian mono PCM, base64 on
 * the wire, 16 kHz from the microphone and 24 kHz from Director. The browser works in
 * float samples at whatever rate its audio hardware runs (usually 44.1 or 48 kHz), so
 * the microphone is brought down to 16 kHz here; Director's voice is played at its own
 * rate and the browser resamples it.
 */
import { base64OfBytes } from "./media";

/** What the Live API takes from the microphone. */
export const CAPTURE_RATE = 16_000;
/** What Director's voice comes back at. */
export const PLAYBACK_RATE = 24_000;

/**
 * A resampler from `fromRate` down to `toRate`, fed one chunk at a time: each output
 * sample is the average of the input samples it stands for (a box filter, which also
 * keeps most of what's above the new rate's limit from folding back as noise). Window
 * bounds are counted from the start of the stream, so chunks of any size give exactly
 * the samples the whole would.
 */
export function downsampler(fromRate: number, toRate = CAPTURE_RATE) {
  if (fromRate < toRate) {
    throw new RangeError(`can't resample ${fromRate} Hz up to ${toRate} Hz`);
  }
  const step = fromRate / toRate;
  let produced = 0;
  // Input samples already used and let go of, and those kept for the next window.
  let dropped = 0;
  let kept = new Float32Array(0);
  return (input: Float32Array): Float32Array => {
    const samples = new Float32Array(kept.length + input.length);
    samples.set(kept);
    samples.set(input, kept.length);
    const output: number[] = [];
    for (;;) {
      const from = Math.floor(produced * step) - dropped;
      const to = Math.floor((produced + 1) * step) - dropped;
      if (to > samples.length) {
        break;
      }
      let sum = 0;
      for (const sample of samples.subarray(from, to)) {
        sum += sample;
      }
      output.push(sum / (to - from));
      produced += 1;
    }
    const next = Math.floor(produced * step) - dropped;
    kept = samples.slice(next);
    dropped += next;
    return Float32Array.from(output);
  };
}

/** Float samples (-1 to 1) as 16-bit integers, clipped. */
export function toPcm16(samples: Float32Array): Int16Array {
  return Int16Array.from(samples, (sample) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    return Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff);
  });
}

/** 16-bit integers as float samples. */
export function fromPcm16(pcm: Int16Array): Float32Array<ArrayBuffer> {
  return Float32Array.from(pcm, (sample) => sample / 0x8000);
}

export function encodePcm16(pcm: Int16Array): string {
  const bytes = new DataView(new ArrayBuffer(pcm.length * 2));
  for (const [at, sample] of pcm.entries()) {
    bytes.setInt16(at * 2, sample, true);
  }
  return base64OfBytes(new Uint8Array(bytes.buffer));
}

/** Base64 PCM as samples; a trailing odd byte, half a sample, is dropped. */
export function decodePcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new DataView(Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer);
  return Int16Array.from({ length: Math.floor(binary.length / 2) }, (_, at) =>
    bytes.getInt16(at * 2, true),
  );
}

/** Speech sits well below full scale: this much RMS already reads as a full orb. */
const FULL_LEVEL_RMS = 0.3;

/** How loud `samples` are, from 0 (silence) to 1. */
export function levelOf(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) / FULL_LEVEL_RMS);
}

/**
 * A WAV file's samples and rate, as Director's spoken lines come (`director.speak`:
 * Gemini's text-to-speech, 16-bit mono). Null for anything else: a file with no `fmt `
 * or `data` chunk, or samples of another size.
 */
export function wavSamples(file: ArrayBuffer): { pcm: Int16Array; rate: number } | null {
  const view = new DataView(file);
  // Only ever read where four bytes are there: past the length check, or inside the loop's.
  const tag = (at: number) => String.fromCharCode(...new Uint8Array(file, at, 4));
  if (file.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    return null;
  }
  let rate = 0;
  let bits = 0;
  for (let at = 12; at + 8 <= file.byteLength; ) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag(at) === "fmt " && body + 16 <= file.byteLength) {
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    }
    if (tag(at) === "data") {
      if (bits !== 16 || rate === 0) {
        return null;
      }
      const length = Math.floor(Math.min(size, file.byteLength - body) / 2);
      const pcm = Int16Array.from({ length }, (_, sample) =>
        view.getInt16(body + sample * 2, true),
      );
      return { pcm, rate };
    }
    // Chunks are padded to an even length.
    at = body + size + (size % 2);
  }
  return null;
}
