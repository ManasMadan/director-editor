/**
 * One of Director's turns on the slower line (director.chat) as product analytics, in the
 * same shape as the live line's (apps/api/src/modules/live/live.turns.ts): what started
 * it, the tools it called, whether Director said anything and how long its answer took.
 * Never the words, the member's or Director's.
 */
import type { DirectorChatInput, DirectorChatReply } from "@repo/contracts/api";

export function chatTurnDetail(input: DirectorChatInput, reply: DirectorChatReply, ms: number) {
  return {
    line: "chat",
    shot: input.shotIndex,
    // "said" is the member, spoken (dictated) or typed alike; the rest are the app's own.
    input: input.turn.kind === "said" ? "said" : `app:${input.turn.kind}`,
    latencyMs: Math.max(0, Math.round(ms)),
    tools: reply.calls.map((call) => call.name),
    interrupted: false,
    spoke: reply.reply.trim().length > 0,
  };
}
