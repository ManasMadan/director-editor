/**
 * Director's slower line, for when Gemini Live can't run: the same controls as a Live
 * session (live-session.ts), so the shoot screen and its tools don't know which line
 * Director is on, but one turn at a time through `director.chat` instead of a socket.
 * The member's words come from the text box or the browser's dictation (dictation.ts);
 * each turn goes up with a frame of the camera, the shot, what the shoot changed and the
 * last lines said; Director's reply is captioned at once, its tool calls are handed to
 * the screen as Live's are, and the reply is spoken with `director.speak` (Gemini's
 * text-to-speech) in Live's voice.
 *
 * Turns go one at a time, in order. When Gemini can't be reached, the session stays (the
 * member can keep filming) and says so (`onAway`) until a turn gets through again; when
 * the slower line itself is off, it ends like a Live session would.
 */
import { errorCode } from "@repo/client";
import {
  DIRECTOR_CHAT_RECENT_LINES,
  type DirectorChatInput,
  type DirectorChatReply,
  type DirectorChatTurn,
  type DirectorSpeech,
  type DirectorVoice,
  type MemoryNote,
  type YourVersion,
} from "@repo/contracts/api";
import type { ErrorCode } from "@repo/contracts/errors";
import { type VideoId, videoIdSchema } from "@repo/contracts/ids";
import {
  type Facing,
  LIVE_VOICE,
  type LiveRollState,
  type LiveTakeState,
  type LiveTool,
  type LiveToolResult,
} from "@repo/contracts/live";
import type { RefObject } from "react";
import { type Dictation, startDictation } from "./dictation";
import type { Speaker } from "./live";
import { createPlayer, liveAudio, type Player } from "./live-audio";
import { type LiveEvents, picture } from "./live-session";
import { base64Of, captureFrame } from "./media";
import { wavSamples } from "./pcm";

/** What the slower line needs from the API: a turn, and a line in Director's voice. */
export interface SlowLineApi {
  chat: (input: DirectorChatInput) => Promise<DirectorChatReply>;
  speak: (input: { text: string; voice: DirectorVoice }) => Promise<DirectorSpeech>;
}

interface SlowEvents extends LiveEvents {
  /** The member said something Director will answer (dictated; typed lines show themselves). */
  onSaid: (text: string) => void;
  /** Whether Gemini is out of reach right now: Director is silent, filming carries on. */
  onAway: (away: boolean) => void;
}

/** Failures after which the slower line can't help: it ends, and the screen says why. */
const ENDING: readonly ErrorCode[] = [
  "FEATURE_DISABLED",
  "UNAUTHENTICATED",
  "NO_ACTIVE_ORGANIZATION",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_SHOT_NOT_FOUND",
];
/** The takes Director answers on the slower line: a called-off count, and a take to watch back. */
const ANSWERED_TAKES: readonly LiveTakeState[] = ["cancelled", "recorded"];
/** Where the roll is recording, so Director marks attempts. */
const ROLLING: readonly LiveRollState[] = ["recording", "resumed"];
const FRAME_WIDTH = 640;
const FRAME_QUALITY = 0.6;
/** What `director.speak` reads in one go; a longer reply is still captioned in full. */
const SPOKEN_MAX_LENGTH = 500;
const RECENT_LINE_LENGTH = 300;

export interface SlowTarget {
  videoId: string;
  shot: number;
  held: boolean;
  video: RefObject<HTMLVideoElement | null>;
  /** The member's version so far: every turn carries it. */
  version: () => YourVersion;
  api: SlowLineApi;
  events: SlowEvents;
}

/** What the camera shows now, as JPEG base64; none while it has no picture. */
async function frameOf(video: HTMLVideoElement | null): Promise<string | undefined> {
  if (!video) {
    return undefined;
  }
  try {
    return await base64Of(await captureFrame(video, FRAME_WIDTH, FRAME_QUALITY));
  } catch {
    // No picture (the camera flipping or not on yet): Director answers from the words.
    return undefined;
  }
}

/** Plays Director's reply in its voice; a line that can't be had or read stays a caption. */
async function speakInto(api: SlowLineApi, text: string, player: Player) {
  try {
    const { url } = await api.speak({ text: text.slice(0, SPOKEN_MAX_LENGTH), voice: LIVE_VOICE });
    const samples = wavSamples(await (await fetch(url)).arrayBuffer());
    if (samples) {
      player.play(samples.pcm, samples.rate);
    }
  } catch {
    // Captions carry every word Director says; a voice that didn't come is only quieter.
    return;
  }
}

/** One slower line, from its first turn until it's let go. */
class SlowLine {
  shot: number;
  held: boolean;
  private over = false;
  private away = false;
  private toolIds = 0;
  private queue = Promise.resolve();
  private readonly recent: { who: Speaker; text: string }[] = [];
  private readonly asked = new Map<string, LiveTool>();
  private answers: DirectorChatInput["answers"] = [];
  readonly player: Player;
  private readonly dictation: Dictation | null;
  private readonly videoId: VideoId;
  /** The roll is recording: Director marks attempts. */
  rolling = false;
  /** Paused: nothing of the member (dictation, the camera) goes to Director. */
  private muted = false;

  constructor(private readonly target: SlowTarget) {
    this.shot = target.shot;
    this.videoId = videoIdSchema.parse(target.videoId);
    this.held = target.held;
    this.player = createPlayer(liveAudio(), (speaking) => {
      target.events.onSpeaking(speaking);
      // Director's voice from the speaker would come back as the member's words.
      this.dictation?.pause(speaking || this.held || this.muted);
    });
    this.player.hold(this.held);
    this.dictation = startDictation({
      onSaid: (text) => {
        target.events.onSaid(text);
        this.turn({ kind: "said", text });
      },
      onDeaf: target.events.onDeaf,
    });
  }

  /** One turn: sent once the one before it has its answer, so Director hears them in order. */
  turn(next: DirectorChatTurn) {
    this.queue = this.queue.then(() => this.send(next));
  }

  hold(on: boolean) {
    this.held = on;
    this.player.hold(on);
    this.dictation?.pause(on || this.muted);
  }

  mute(on: boolean) {
    this.muted = on;
    this.dictation?.pause(on || this.held);
  }

  answer(id: string, result: LiveToolResult) {
    const tool = this.asked.get(id);
    this.asked.delete(id);
    if (tool) {
      this.answers = [...this.answers, { tool, result }];
    }
  }

  leave() {
    this.over = true;
    this.dictation?.stop();
    this.player.close();
  }

  private remember(who: Speaker, text: string) {
    this.recent.push({ who, text: text.slice(0, RECENT_LINE_LENGTH) });
    this.recent.splice(0, Math.max(0, this.recent.length - DIRECTOR_CHAT_RECENT_LINES));
  }

  private async send(next: DirectorChatTurn) {
    if (this.over) {
      return;
    }
    const input: DirectorChatInput = {
      videoId: this.videoId,
      shotIndex: this.shot,
      turn: next,
      frame: this.muted ? undefined : await frameOf(this.target.video.current),
      rolling: this.rolling,
      adaptations: this.target.version().shots,
      version: this.target.version(),
      recent: [...this.recent],
      answers: this.answers,
    };
    this.answers = [];
    if (next.kind === "said") {
      this.remember("you", next.text);
    }
    try {
      const reply = await this.target.api.chat(input);
      if (!this.over) {
        await this.reply(reply);
      }
    } catch (error) {
      if (!this.over) {
        this.fail(error);
      }
    }
  }

  private reply(reply: DirectorChatReply) {
    const { events } = this.target;
    this.setAway(false);
    if (reply.reply) {
      events.onTranscript("director", reply.reply);
      events.onTurn();
      this.remember("director", reply.reply);
    }
    for (const call of reply.calls) {
      this.toolIds += 1;
      const id = `slow-${this.toolIds}`;
      this.asked.set(id, call.name);
      events.onTool(id, call);
    }
    return reply.reply && !this.held
      ? speakInto(this.target.api, reply.reply, this.player)
      : undefined;
  }

  private fail(error: unknown) {
    const code = errorCode(error);
    if (ENDING.includes(code)) {
      this.leave();
      this.target.events.onEnd(code);
      return;
    }
    this.setAway(true);
  }

  private setAway(away: boolean) {
    if (this.away !== away) {
      this.away = away;
      this.target.events.onAway(away);
    }
  }
}

/**
 * Starts the slower line on shot `target.shot`: Director speaks first. Run it from a tap,
 * or after one, so the page may make sound ("Start shooting" woke the shoot's audio).
 */
export function startSlowSession(target: SlowTarget) {
  const line = new SlowLine(target);
  target.events.onLive();
  line.turn({ kind: "start" });
  return {
    leave: () => line.leave(),
    moveTo: (index: number) => {
      line.shot = index;
    },
    hold: (on: boolean) => line.hold(on),
    level: () => line.player.level(),
    /** A typed line for Director: always heard, answered in turn. */
    say: (text: string) => {
      line.turn({ kind: "said", text });
      return true;
    },
    /** What came of a tool call: Director hears it with the next turn. */
    answer: (id: string, result: LiveToolResult) => line.answer(id, result),
    /** The member flipped the camera: once its picture is up, Director looks at the new view. */
    camera: async (facing: Facing) => {
      await picture(target.video.current);
      line.turn({ kind: "camera", facing });
    },
    take: (state: LiveTakeState) => {
      if (ANSWERED_TAKES.includes(state)) {
        line.turn({ kind: "take", state });
      }
    },
    /** Where the roll is: Director marks attempts while it records, and hears a pause. */
    roll: (state: LiveRollState) => {
      line.rolling = ROLLING.includes(state);
      line.turn({ kind: "roll", state });
    },
    /** Paused: nothing of the member goes to Director (dictation, the camera). */
    mute: (on: boolean) => line.mute(on),
    /** The member's version rides along with every turn: nothing to send now. */
    share: () => undefined,
    /** The member took a chip away: Director acknowledges it in its next words. */
    forgot: (note: MemoryNote) => line.turn({ kind: "forgot", memory: note.kind, note: note.note }),
    /** A row put back is in the version the next turn carries. */
    restored: () => undefined,
  };
}
