/**
 * Director's tools, checked the same way whichever line Gemini speaks on: Gemini Live
 * through the relay (live.relay.ts), or Gemini Flash turn by turn when Live can't run
 * (live.chat.ts). A call's arguments are read against the plan (a shot it has, a change
 * within the contract's bounds) and turned into the call the browser carries out, or
 * into the answer Gemini hears at once when it can't be done. What each answer from the
 * browser means to Gemini is here too, so both lines tell it the same thing.
 */
import type { ShotPlan } from "@repo/contracts/api";
import {
  LIVE_ADAPTATION_MAX_LENGTH,
  LIVE_MARK_TEXT_MAX_LENGTH,
  LIVE_TOOLS,
  type LiveTool,
  type LiveToolCall,
  type LiveToolResult,
  liveAdaptation,
  liveToolCall,
} from "@repo/contracts/live";
import { NOT_FOUND_RESPONSE, pointAtCall } from "./live.marks";
import { toolArgsSchemas } from "./live.messages";

/** What Gemini hears for each of the browser's answers to a tool call. */
export const TOOL_RESPONSES: Record<LiveToolResult | "unknown", object> = {
  unknown: { result: "unknown", why: "The app didn't answer." },
  done: { result: "done" },
  busy: {
    result: "refused",
    why: "A take is under way: counting down, recording or being watched back. Wait until they've kept it or gone again.",
  },
  no_camera: { result: "refused", why: "Their camera isn't on." },
  not_found: NOT_FOUND_RESPONSE,
  paused: {
    result: "refused",
    why: "Recording is paused. Only their own tap on Resume starts it again.",
  },
  not_recording: { result: "refused", why: "Nothing is recording right now." },
  failed: {
    result: "failed",
    why: "It didn't work just now. Say so in a few words and carry on with the shot as it is.",
  },
  not_asked: {
    result: "refused",
    why: "You just changed their plan and they haven't asked to move on. Stay on this shot: ask whether they want to move on, and move only once they say so.",
  },
  not_filmed: {
    result: "refused",
    why: "That shot isn't in their version any more (skipped, or a gap the edit fills). If they want to film it after all, restore_shot it first.",
  },
};

/** The call for the browser, or what Gemini hears at once because it can't be done. */
export type ToolCheck = { call: LiveToolCall } | { response: object };

/** One of Director's tools by Gemini's name for it, or null for a name it made up. */
export function toolNamed(name: string): LiveTool | null {
  return LIVE_TOOLS.find((tool) => tool === name) ?? null;
}

function noShot(shot: number, count: number) {
  return {
    response: { result: "not_found", why: `There's no shot ${shot}: they go from 1 to ${count}.` },
  };
}

/**
 * The member's version of a shot, as Gemini put it: a shot the plan has, and at least
 * one of where, what and the line, each a sentence or two (the contract's bounds).
 */
function adaptCall(plan: ShotPlan, raw: unknown): ToolCheck {
  const args = toolArgsSchemas.adapt_shot.safeParse(raw ?? {});
  if (!args.success) {
    return { response: { error: "shot must be a whole number, the rest text" } };
  }
  const { shot, where, action, line, framing, camera } = args.data;
  const count = plan.shots.length;
  if (shot < 1 || shot > count) {
    return noShot(shot, count);
  }
  const adaptation = liveAdaptation.safeParse({
    shot: shot - 1,
    where,
    action,
    line,
    framing,
    camera,
  });
  if (!adaptation.success) {
    const error = `each of where, action, line and framing is one to ${LIVE_ADAPTATION_MAX_LENGTH} characters`;
    return { response: { error } };
  }
  const { data } = adaptation;
  if (!(data.where || data.action || data.line || data.framing || data.camera)) {
    return { response: { error: "say what changed: where, action, line, framing or camera" } };
  }
  return { call: { name: "adapt_shot", ...data } };
}

/** An attempt starts or ends, with Director's few words on it, trimmed to the contract's bounds. */
function markCall(raw: unknown): ToolCheck {
  const args = toolArgsSchemas.mark.safeParse(raw ?? {});
  if (!args.success) {
    return { response: { error: 'event must be "start" or "end", line and note text' } };
  }
  const { event } = args.data;
  const text = (value: string | undefined) =>
    value?.trim().slice(0, LIVE_MARK_TEXT_MAX_LENGTH) || undefined;
  const line = text(args.data.line);
  const note = text(args.data.note);
  return {
    call: { name: "mark", event, ...(line ? { line } : {}), ...(note ? { note } : {}) },
  };
}

/**
 * The tools that change the member's version as a whole (remember, forget, skip, restore,
 * re-plan): their arguments read with the contract, and a shot the plan has.
 */
function versionCall(
  plan: ShotPlan,
  name: Exclude<LiveTool, "go_to_shot" | "switch_camera" | "adapt_shot" | "point_at" | "mark">,
  raw: unknown,
): ToolCheck {
  const args = toolArgsSchemas[name].safeParse(raw ?? {});
  if (!args.success) {
    return { response: { error: `the arguments don't fit ${name}` } };
  }
  const fields: Record<string, unknown> = { ...args.data, name };
  if ("shot" in args.data) {
    const count = plan.shots.length;
    if (args.data.shot < 1 || args.data.shot > count) {
      return noShot(args.data.shot, count);
    }
    fields.shot = args.data.shot - 1;
  }
  const call = liveToolCall.safeParse(fields);
  return call.success
    ? { call: call.data }
    : { response: { error: `the arguments don't fit ${name}` } };
}

/** Gemini's call of `name` with `raw` arguments, checked against the plan. */
export function checkTool(plan: ShotPlan, name: LiveTool, raw: unknown): ToolCheck {
  switch (name) {
    case "go_to_shot": {
      const args = toolArgsSchemas.go_to_shot.safeParse(raw ?? {});
      if (!args.success) {
        return { response: { error: "shot must be a whole number" } };
      }
      const count = plan.shots.length;
      const { shot } = args.data;
      if (shot < 1 || shot > count) {
        return noShot(shot, count);
      }
      return { call: { name, shot: shot - 1 } };
    }
    case "switch_camera": {
      const args = toolArgsSchemas.switch_camera.safeParse(raw ?? {});
      if (!args.success) {
        return { response: { error: 'to must be "front" or "back"' } };
      }
      return { call: { name, to: args.data.to } };
    }
    case "adapt_shot":
      return adaptCall(plan, raw);
    case "point_at":
      return pointAtCall(raw);
    case "mark":
      return markCall(raw);
    default:
      return versionCall(plan, name, raw);
  }
}
