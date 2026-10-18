/**
 * Director's slower line: when Gemini Live can't run, the shoot screen talks to Director
 * one turn at a time through `director.chat`, and this asks Gemini Flash on Vertex AI
 * (generateContent) for each reply. It is the same Director as on Live: the same persona
 * and shot brief (live.setup.ts's systemInstruction, with a few lines on how this line
 * differs), the same tools (live.setup.ts's declarations) checked by the same code
 * (live.tools.ts), and the same notes for what happened on screen. The browser carries
 * the calls out with the code it uses for Live's, and speaks the reply with
 * `director.speak` (Gemini's text-to-speech), in Live's voice.
 *
 * Nothing is kept between turns: the browser sends the last few lines said, what the
 * shoot changed, and what came of the last reply's tool calls with every turn.
 *
 * When Gemini answers with only tool calls, a second request gets the words to go with
 * them: the calls Gemini made are answered as the browser will carry them out (done, or
 * refused at once when they can't be), so it knows what it's confirming.
 *
 * Swapping the model or the provider: `ChatUpstream` says where requests go; the request
 * and response shapes are Vertex AI's generateContent, in their JSON form.
 */
import type { DirectorChatInput, DirectorChatReply, ShotPlan } from "@repo/contracts/api";
import type { LiveToolCall } from "@repo/contracts/live";
import { PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import { AppError, describeError } from "@repo/nest-common";
import * as z from "zod";
import type { GoogleAuth } from "./google-auth";
import type { LiveLog } from "./live.relay";
import { cameraMessage, functionDeclarations, systemInstruction, takeMessage } from "./live.setup";
import { checkTool, TOOL_RESPONSES, toolNamed } from "./live.tools";

/** Where the slower line's requests go, or null when Director live is off. */
export interface ChatUpstream {
  /** The model's generateContent URL. */
  url: string;
  auth: GoogleAuth;
}

/** Gemini Flash models on Vertex AI are served from the global endpoint. */
const CHAT_LOCATION = "global";

/**
 * The upstream for the environment's settings; null with no Google Cloud project. `url`
 * is the tests' stand-in (CHAT_API_URL); unset, Vertex AI's global endpoint.
 */
export function chatUpstream(settings: {
  project: string | undefined;
  model: string;
  url?: string | undefined;
  auth: GoogleAuth;
}): ChatUpstream | null {
  if (!settings.project) {
    return null;
  }
  const base = settings.url ?? "https://aiplatform.googleapis.com";
  return {
    url: `${base}/v1/projects/${settings.project}/locations/${CHAT_LOCATION}/publishers/google/models/${settings.model}:generateContent`,
    auth: settings.auth,
  };
}

/** What changes on this line, after Live's persona and the shot. */
const SLOWER = `Right now you're on the slower line: you can't hear them live. You get their words as text, typed or dictated by their phone (which may mishear a word: go with what they most likely meant), and a still of their camera when there is one. Your reply is read aloud, so it's one or two short spoken sentences, no lists, no brackets. When you use a tool, say your line in the same reply. Nothing else changes: same you, same rules.`;

/** Short spoken answers: a sentence or two, with room for a tool call's arguments. */
const MAX_OUTPUT_TOKENS = 400;
/** A quick turn matters more than deep thought: Director answers in about a second. */
const THINKING_LEVEL = "LOW";

const functionCall = z.object({ name: z.string(), args: z.unknown().optional() });
// Parts are kept as they came (thought signatures included), to hand back in a second request.
const part = z.looseObject({ text: z.string().optional(), functionCall: functionCall.optional() });
const generateResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z.looseObject({ parts: z.array(part).optional() }).optional(),
      }),
    )
    .optional(),
});
type Part = z.infer<typeof part>;

interface Content {
  role: "user" | "model";
  parts: object[];
}

/** A note from live.setup.ts, as text: what it says, and whether it wants an answer. */
function noteOf(message: {
  clientContent: { turns: { parts: { text: string }[] }[]; turnComplete: boolean };
}) {
  const text = message.clientContent.turns.flatMap((turn) => turn.parts.map((p) => p.text));
  return { text: text.join("\n"), answer: message.clientContent.turnComplete };
}

/** This turn as Gemini reads it, and whether it wants an answer at all. */
function turnText(input: DirectorChatInput): { text: string; answer: boolean } {
  const { turn, shotIndex } = input;
  switch (turn.kind) {
    case "said":
      return { text: turn.text, answer: true };
    case "start":
      return {
        text: `[They're shooting, on shot ${shotIndex + 1}, and you're on the slower line for now: you'll take a moment longer to answer. Say hi in one sentence, mentioning lightly that you're a bit slow to answer right now (never why, never anything technical), then ask one question to get going.]`,
        answer: true,
      };
    case "camera":
      return noteOf(cameraMessage(turn.facing));
    case "take":
      return noteOf(takeMessage(turn.state, shotIndex));
  }
}

/** What Gemini should know before the turn: what was said last and what came of its calls. */
function contextText(input: DirectorChatInput): string | null {
  const said = input.recent.map(({ who, text }) => `${who === "you" ? "Them" : "You"}: ${text}`);
  const answers = input.answers.map(
    ({ tool, result }) => `${tool}: ${JSON.stringify(TOOL_RESPONSES[result])}`,
  );
  const notes = [
    said.length > 0 ? `[What was said last:\n${said.join("\n")}]` : null,
    answers.length > 0 ? `[What came of what you did last time:\n${answers.join("\n")}]` : null,
  ].filter((note) => note !== null);
  return notes.length > 0 ? notes.join("\n") : null;
}

/** The member's turn, with the camera's frame and what came before it. */
function userContent(input: DirectorChatInput, text: string): Content {
  const context = contextText(input);
  return {
    role: "user",
    parts: [
      ...(context ? [{ text: context }] : []),
      ...(input.frame ? [{ inlineData: { mimeType: "image/jpeg", data: input.frame } }] : []),
      { text },
    ],
  };
}

/** The words of an answer, and its function calls. */
function read(parts: Part[]) {
  const text = parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  const calls = parts.flatMap((p) => (p.functionCall ? [p.functionCall] : []));
  return { text, calls };
}

export class DirectorChat {
  constructor(
    private readonly upstream: ChatUpstream | null,
    private readonly log: LiveLog,
  ) {}

  /** Director's reply to one turn on shot `input.shotIndex` of `plan`. */
  async reply(plan: ShotPlan, input: DirectorChatInput): Promise<DirectorChatReply> {
    const upstream = this.upstream;
    if (!upstream) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "live" } });
    }
    if (input.shotIndex >= plan.shots.length) {
      throw new AppError("DIRECTOR_SHOT_NOT_FOUND");
    }
    const turn = turnText(input);
    // A note Director only needs to know (a take starting): nothing to say, nothing to ask.
    if (!turn.answer) {
      return { reply: "", calls: [] };
    }
    const version = input.adaptations.find((a) => a.shot === input.shotIndex);
    const system = `${systemInstruction(plan, input.shotIndex, version)}\n\n${SLOWER}`;
    const contents: Content[] = [userContent(input, turn.text)];
    const first = await this.generate(upstream, system, contents);
    const { text, calls: raw } = read(first);
    const calls: LiveToolCall[] = [];
    const responses: object[] = [];
    for (const call of raw) {
      const name = toolNamed(call.name);
      const checked = name
        ? checkTool(plan, name, call.args)
        : { response: { error: "unknown tool" } };
      if ("call" in checked) {
        calls.push(checked.call);
      }
      const response = "call" in checked ? TOOL_RESPONSES.done : checked.response;
      responses.push({ functionResponse: { name: call.name, response } });
    }
    if (text || raw.length === 0) {
      return { reply: text, calls };
    }
    // Only calls: Gemini says what it did, knowing how each went.
    contents.push({ role: "model", parts: first }, { role: "user", parts: responses });
    const second = read(await this.generate(upstream, system, contents));
    return { reply: second.text, calls };
  }

  private async generate(upstream: ChatUpstream, system: string, contents: Content[]) {
    let response: Response;
    try {
      const token = await upstream.auth.accessToken();
      response = await fetch(upstream.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          tools: [{ functionDeclarations }],
          generationConfig: {
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinkingConfig: { thinkingLevel: THINKING_LEVEL },
          },
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      this.log("error", { err: describeError(error) }, "director chat failed");
      throw new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "gemini" }, cause: error });
    }
    const body: unknown = await response.json().catch(() => null);
    const parsed = generateResponse.safeParse(body);
    if (!(response.ok && parsed.success)) {
      this.log("error", { status: response.status, body }, "director chat refused");
      throw new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "gemini" } });
    }
    return parsed.data.candidates?.[0]?.content?.parts ?? [];
  }
}
