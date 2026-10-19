/**
 * A stand-in for Vertex AI's generateContent as Director's slower line calls it (the
 * API's `director.chat`, when Gemini Live can't run), at the path Vertex serves a model
 * from. Like the real one it checks the bearer token and answers a body it can't read
 * with a 400.
 *
 * What it says is scripted from the turn's last text: the slower line's opening note
 * gets a hello, "inside" gets a line and an adapt_shot moving the shot indoors, "go to
 * shot N" gets go_to_shot with only the call (so the API asks again for the words, with
 * the call's answer), an answer to a call gets a word that it's done, other notes in
 * square brackets get a line, and anything else gets "Got it." The server's
 * `chatOutage(true)` has it answer 503 to everything, as Gemini out of reach.
 */
import * as z from "zod";

export const CHAT_API_PATH =
  /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\/([^/:]+):generateContent$/;

const part = z.object({
  text: z.string().optional(),
  functionResponse: z.object({ name: z.string() }).optional(),
});
const chatRequest = z.object({
  systemInstruction: z.object({ parts: z.array(z.object({ text: z.string() })) }),
  contents: z.array(z.object({ role: z.string(), parts: z.array(part) })).min(1),
});

/** The shot the system instruction briefs, from 1 ("Shot 2 of 3: ..."). */
function shotOf(system: string): number {
  return Number(/Shot (\d+) of \d+/.exec(system)?.[1] ?? "1");
}

function answer(text: string | null, calls: { name: string; args: object }[] = []) {
  const parts = [
    ...(text ? [{ text }] : []),
    ...calls.map((call) => ({ functionCall: call, thoughtSignature: "c2lnbmVk" })),
  ];
  return { candidates: [{ content: { role: "model", parts } }], usageMetadata: CHAT_USAGE };
}

/**
 * What every answer says it cost, as Vertex reports it: the prompt, and the answer with
 * the model's thinking (billed as output) in the total.
 */
export const CHAT_USAGE = {
  promptTokenCount: 1_200,
  candidatesTokenCount: 30,
  thoughtsTokenCount: 20,
  totalTokenCount: 1_250,
};

/** generateContent's answer to `body`, or null when it isn't a request it can read. */
export function chatAnswer(body: unknown): object | null {
  const parsed = chatRequest.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const { systemInstruction, contents } = parsed.data;
  const last = contents.at(-1)?.parts ?? [];
  if (last.some((p) => p.functionResponse)) {
    return answer("Done, you're there.");
  }
  const said = last.at(-1)?.text ?? "";
  const shot = shotOf(systemInstruction.parts.map((p) => p.text).join("\n"));
  const moveTo = /go to shot (\d+)/i.exec(said);
  if (moveTo) {
    return answer(null, [{ name: "go_to_shot", args: { shot: Number(moveTo[1]) } }]);
  }
  if (/\binside\b/i.test(said) && !said.startsWith("[")) {
    return answer("Totally, inside it is. Stand so the window's just behind you.", [
      { name: "adapt_shot", args: { shot, where: "Inside, by a window" } },
    ]);
  }
  if (said.includes("slower line")) {
    return answer("Hey! I'm a bit slow to answer right now. How much time have you got?");
  }
  if (said.startsWith("[")) {
    return answer("Nice, that looked good.");
  }
  return answer("Got it.");
}
