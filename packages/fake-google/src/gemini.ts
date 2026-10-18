/**
 * The Gemini API's generateContent, as Director's agents call it (apps/ai, through
 * Pydantic AI and google-genai): each asks for its output through a tool named
 * `final_result`, whose parameters say which it is. The answers are mock
 * data, worked out from what the request carries:
 *
 * - a shot plan: the plan for the short at the request's YouTube `file_uri` (./plans.ts);
 * - a take review: keeps the take from just after its start for the shot's length, with
 *   a score and feedback named after the shot; a photo has no part to keep.
 */
import * as z from "zod";
import { shortOf } from "./catalog";
import { planFor } from "./plans";

const part = z.looseObject({
  text: z.string().optional(),
  fileData: z
    .looseObject({ file_uri: z.string().optional(), fileUri: z.string().optional() })
    .optional(),
  inlineData: z
    .looseObject({
      mimeType: z.string().optional(),
      mime_type: z.string().optional(),
      data: z.string().optional(),
    })
    .optional(),
});
export const generateRequest = z.looseObject({
  contents: z.array(z.looseObject({ parts: z.array(part) })),
  tools: z
    .array(
      z.looseObject({
        functionDeclarations: z
          .array(
            z.looseObject({
              name: z.string(),
              parameters_json_schema: z
                .looseObject({ properties: z.record(z.string(), z.unknown()).optional() })
                .optional(),
              parametersJsonSchema: z
                .looseObject({ properties: z.record(z.string(), z.unknown()).optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});
export type GenerateRequest = z.infer<typeof generateRequest>;

/** What Director's agents ask Gemini for, by their output's fields. */
type Ask = "plan" | "review";

/** Which agent is asking, by the field its output has that the others' don't. */
const ASKS: [field: string, ask: Ask][] = [
  ["shots", "plan"],
  ["bestStartSeconds", "review"],
];

function askOf(request: GenerateRequest): Ask | null {
  const fields = new Set(
    (request.tools ?? [])
      .flatMap((tool) => tool.functionDeclarations ?? [])
      .flatMap((declaration) =>
        Object.keys(
          (declaration.parametersJsonSchema ?? declaration.parameters_json_schema)?.properties ??
            {},
        ),
      ),
  );
  return ASKS.find(([field]) => fields.has(field))?.[1] ?? null;
}

const parts = (request: GenerateRequest) => request.contents.flatMap((content) => content.parts);

/** The YouTube video id the request asks Gemini to watch. */
function watchedVideo(request: GenerateRequest): string | null {
  for (const { fileData } of parts(request)) {
    const uri = fileData?.fileUri ?? fileData?.file_uri;
    const id = uri ? new URL(uri).searchParams.get("v") : null;
    if (id) {
      return id;
    }
  }
  return null;
}

const shotText = z.object({
  title: z.string(),
  kind: z.enum(["video", "photo"]).optional(),
  durationSeconds: z.number().optional(),
  camera: z.enum(["front", "back"]).optional(),
});

/** The shot the request describes ("The shot:\n{...}"), as far as the answers use it. */
function shotOf(request: GenerateRequest): z.infer<typeof shotText> | null {
  for (const { text } of parts(request)) {
    if (text?.startsWith("The shot:\n")) {
      return shotText.safeParse(JSON.parse(text.slice("The shot:\n".length))).data ?? null;
    }
  }
  return null;
}

/** A take's review: the shot's length from just after the take starts (a video), and a score. */
function takeReview(shot: z.infer<typeof shotText> | null, takeBytes: number) {
  const title = shot?.title ?? "this shot";
  const score = 70 + (takeBytes % 26);
  const photo = shot?.kind === "photo";
  const length = Math.min(60, shot?.durationSeconds ?? 3);
  return {
    bestStartSeconds: photo ? null : 0.3,
    bestEndSeconds: photo ? null : Math.round((0.3 + length) * 10) / 10,
    score,
    feedback: `Lovely job on "${title}"! Next time, hold the last moment a little longer.`,
  };
}

/** The bytes of the take the request sends inline (base64 counts 4 per 3). */
function inlineBytes(request: GenerateRequest): number {
  return parts(request).reduce(
    (sum, { inlineData }) => sum + Math.floor(((inlineData?.data?.length ?? 0) * 3) / 4),
    0,
  );
}

// What Gemini bills, roughly: an image is 258 tokens, video about 300 a second (a take's
// length guessed from its size at the recorder's 1.5 Mbit/s), text about 4 characters a
// token. A watched YouTube video counts as a minute.
const IMAGE_TOKENS = 258;
const VIDEO_TOKENS_PER_SECOND = 300;
const TAKE_BYTES_PER_SECOND = 190_000;

/** The tokens a request's prompt costs, as Gemini would count them. */
export function promptTokens(request: GenerateRequest): number {
  return parts(request).reduce((sum, { text, inlineData, fileData }) => {
    const type = inlineData?.mimeType ?? inlineData?.mime_type ?? "";
    const bytes = Math.floor(((inlineData?.data?.length ?? 0) * 3) / 4);
    if (type.startsWith("video/")) {
      return sum + Math.ceil(bytes / TAKE_BYTES_PER_SECOND) * VIDEO_TOKENS_PER_SECOND;
    }
    if (type.startsWith("image/")) {
      return sum + IMAGE_TOKENS;
    }
    if (fileData) {
      return sum + 60 * VIDEO_TOKENS_PER_SECOND;
    }
    return sum + Math.ceil((text?.length ?? 0) / 4);
  }, 0);
}

/** The answer to one generateContent call (null: not something Director asks). */
export function answer(request: GenerateRequest): object | null {
  const ask = askOf(request);
  if (ask === "plan") {
    return planFor(shortOf(watchedVideo(request) ?? "").template);
  }
  if (ask === "review") {
    return takeReview(shotOf(request), inlineBytes(request));
  }
  return null;
}

/** generateContent's response: the output tool called with `args`, and what it cost. */
export function generateResponse(model: string, args: object, promptTokenCount: number) {
  const prompt = Math.max(100, promptTokenCount);
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ functionCall: { name: "final_result", args } }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: prompt,
      candidatesTokenCount: 400,
      totalTokenCount: prompt + 400,
    },
    modelVersion: model,
    responseId: `mock-${Date.now()}`,
  };
}
