/**
 * Director live's sound in the browser: the microphone, captured off the main thread by an
 * AudioWorklet and handed over as 16 kHz PCM, and Director's voice, its 24 kHz chunks
 * queued back to back so it plays as one stream, and dropped at once when the member
 * talks over it (barge-in). The level of what plays animates Director's orb.
 */
import { stopStream } from "./media";
import { downsampler, fromPcm16, levelOf, PLAYBACK_RATE, toPcm16 } from "./pcm";

const CAPTURE_PROCESSOR = "director-capture";
/** About 100 ms of microphone a message: what the relay expects, not one per render quantum. */
const CHUNK_SECONDS = 0.1;
/** A moment's head start for the first chunk, so it doesn't start with a click. */
const LEAD_SECONDS = 0.05;

// The worklet runs in the audio thread's own scope, which can't import the app's modules
// or be bundled with them: its source is this string, loaded from a blob: URL (the CSP's
// 'strict-dynamic' lets a script the page itself loads in, which this is).
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunk = new Float32Array(options.processorOptions.chunk);
    this.filled = 0;
    this.running = true;
    // Told to stop when Director goes: returning false lets the audio thread drop it.
    this.port.onmessage = () => {
      this.running = false;
    };
  }
  process(inputs) {
    for (const sample of inputs[0]?.[0] ?? []) {
      this.chunk[this.filled] = sample;
      this.filled += 1;
      if (this.filled === this.chunk.length) {
        this.port.postMessage(this.chunk.slice());
        this.filled = 0;
      }
    }
    return this.running;
  }
}
registerProcessor("${CAPTURE_PROCESSOR}", Capture);
`;

let shared: AudioContext | null = null;
const loaded = new WeakSet<AudioContext>();

/**
 * The page's one audio context for Director live. Browsers let a page make sound only
 * once the member has interacted with it: made (or woken) by the "Start shooting" tap,
 * the same context then serves every reconnection after it, which start by themselves.
 */
export function liveAudio(): AudioContext {
  shared ??= new AudioContext();
  void shared.resume();
  return shared;
}

/** Lets the audio hardware rest once the shoot screen is left. */
export function restLiveAudio() {
  void shared?.suspend();
}

async function loadWorklet(context: AudioContext) {
  if (loaded.has(context)) {
    return;
  }
  const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
    loaded.add(context);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface Microphone {
  /** From now on, each ~100 ms of what the member says goes to `onChunk`. */
  listen(onChunk: (pcm: Int16Array) => void): void;
  stop(): void;
}

/**
 * The microphone, cleaned up by the browser (echo cancellation keeps Director's own voice
 * from coming back as the member's). `onLost` hears when it goes away by itself: unplugged,
 * or the permission taken back mid-shoot.
 */
export async function openMicrophone(
  context: AudioContext,
  onLost: () => void,
): Promise<Microphone> {
  await loadWorklet(context);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let source: MediaStreamAudioSourceNode;
  try {
    // Throws for a stream with no sound in it: Director can't hear anyone then.
    source = context.createMediaStreamSource(stream);
  } catch (error) {
    // The microphone is on by now: it mustn't stay on when Director can't use it.
    stopStream(stream);
    throw error;
  }
  const tracks = stream.getAudioTracks();
  for (const track of tracks) {
    track.addEventListener("ended", onLost);
  }
  const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
    processorOptions: { chunk: Math.round(context.sampleRate * CHUNK_SECONDS) },
  });
  source.connect(node);
  // It outputs silence; connected, the context keeps running it.
  node.connect(context.destination);
  const down = downsampler(context.sampleRate);
  return {
    listen(onChunk) {
      node.port.onmessage = (event: MessageEvent<Float32Array>) =>
        onChunk(toPcm16(down(event.data)));
    },
    stop() {
      node.port.onmessage = null;
      node.port.postMessage("stop");
      source.disconnect();
      node.disconnect();
      for (const track of tracks) {
        track.removeEventListener("ended", onLost);
      }
      stopStream(stream);
    },
  };
}

export type Player = ReturnType<typeof createPlayer>;

/** Director's voice. `onSpeaking` hears when it starts and stops. */
export function createPlayer(context: AudioContext, onSpeaking: (speaking: boolean) => void) {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(context.destination);
  const levels = new Float32Array(analyser.fftSize);
  const playing = new Set<AudioBufferSourceNode>();
  let endsAt = 0;
  let held = false;

  const flush = () => {
    for (const source of playing) {
      source.onended = null;
      source.stop();
    }
    playing.clear();
    endsAt = 0;
    onSpeaking(false);
  };

  return {
    /** Queues a chunk (at `rate`, Live's by default) to play right after the last one. */
    play(pcm: Int16Array, rate = PLAYBACK_RATE) {
      if (held || pcm.length === 0) {
        return;
      }
      const buffer = context.createBuffer(1, pcm.length, rate);
      buffer.copyToChannel(fromPcm16(pcm), 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      const startAt = Math.max(context.currentTime + LEAD_SECONDS, endsAt);
      source.start(startAt);
      endsAt = startAt + buffer.duration;
      source.onended = () => {
        playing.delete(source);
        if (playing.size === 0) {
          onSpeaking(false);
        }
      };
      playing.add(source);
      onSpeaking(true);
    },
    /** Drops what's still to play: the member started talking. */
    flush,
    /**
     * While held, Director's voice is dropped rather than played: a take is recording the
     * member's voice, and the speaker would put Director's in it too.
     */
    hold(on: boolean) {
      held = on;
      if (on) {
        flush();
      }
    },
    /** How loud Director is right now, from 0 to 1. */
    level() {
      analyser.getFloatTimeDomainData(levels);
      return levelOf(levels);
    },
    close() {
      flush();
      analyser.disconnect();
    },
  };
}
