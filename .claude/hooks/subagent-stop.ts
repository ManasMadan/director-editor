/**
 * SubagentStop: holds the reviewer agents and the verifier to their report format, and
 * tells Claude when one found something. A reviewer that stops without its verdict, or
 * the verifier without its results table, is sent back once to finish its report; a
 * verdict or result that isn't a pass reaches Claude as context, so it can't be skimmed
 * past on the way to "done".
 */

import { runMain } from "../../scripts/lib";
import { type HookInput, type HookOutput, hookMain } from "./lib";

/** Each reviewer's verdicts (the last line of its report): what passes, and what doesn't. */
export const VERDICTS: Record<string, { pass: string[]; fail: string[] }> = {
  reviewer: { pass: ["ready"], fail: ["ready after minor fixes", "not ready"] },
  "frontend-reviewer": { pass: ["ready"], fail: ["ready after minor fixes", "not ready"] },
  "python-reviewer": { pass: ["ready"], fail: ["ready after minor fixes", "not ready"] },
  "i18n-checker": { pass: ["ready"], fail: ["not ready"] },
  "migration-reviewer": { pass: ["safe to deploy"], fail: ["safe after fixes", "unsafe"] },
  "security-reviewer": { pass: ["no security blockers"], fail: ["blockers found"] },
};

/** The verdict in the report's last line, or null; longest first, as "not ready" ends in "ready". */
export function verdictOf(message: string, verdicts: string[]): string | null {
  const last = message.trim().split("\n").at(-1)?.toLowerCase() ?? "";
  return [...verdicts].sort((a, b) => b.length - a.length).find((v) => last.includes(v)) ?? null;
}

const context = (text: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: "SubagentStop", additionalContext: text },
});

/** Sends an agent back for its missing verdict, or tells Claude what it found. */
export function subagentStop(input: HookInput): HookOutput {
  // Plugin agents are namespaced (`boilerplate:reviewer`).
  const agent = input.agent_type?.split(":").at(-1) ?? "";
  const message = input.last_assistant_message ?? "";
  // Once: an agent that still can't give a verdict is Claude's to look at, not a loop.
  const sendBack = (reason: string): HookOutput =>
    input.stop_hook_active
      ? context(`The ${agent} agent ended without ${reason}.`)
      : { decision: "block", reason: `End your report with ${reason}.` };

  if (agent === "verifier") {
    const rows = message.match(/^\|[^\n]*\|\s*(pass|fail|not run)\s*\|/gim) ?? [];
    if (rows.length === 0) {
      return sendBack(
        "the verify skill's results table (`| command | pass / fail / not run | duration |`)",
      );
    }
    const open = rows.filter((row) => !/\|\s*pass\s*\|/i.test(row));
    if (open.length === 0) {
      return undefined;
    }
    return context(
      `The verifier reports checks that failed or didn't run:\n${open.join("\n")}\nThe change isn't verified until they pass: fix them, or tell the user which can't run here and why.`,
    );
  }
  const verdicts = VERDICTS[agent];
  if (!verdicts) {
    return undefined;
  }
  const verdict = verdictOf(message, [...verdicts.pass, ...verdicts.fail]);
  if (!verdict) {
    return sendBack(
      `one of these verdicts on its own line: ${[...verdicts.pass, ...verdicts.fail].map((v) => `\`${v}\``).join(", ")}`,
    );
  }
  if (verdicts.pass.includes(verdict)) {
    return undefined;
  }
  return context(
    `The ${agent} agent's verdict is \`${verdict}\`. Fix what it found (or tell the user why a finding doesn't apply), then run it again before calling the work done.`,
  );
}

await runMain(import.meta, hookMain(subagentStop));
