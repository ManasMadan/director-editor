/**
 * The AI features, served by apps/api on top of the Python service (apps/ai). Limits
 * here must match the Python models; a test in apps/api compares them through the
 * generated AI client's schemas.
 */
import { eventIterator } from "@orpc/contract";
import * as z from "zod";
import { documentIdSchema, userIdSchema } from "../ids";
import { HOUR_S } from "../time";
import { base, EVERYDAY_WRITES, errorsOf, WORKSPACE_ERRORS } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "API_KEY_SCOPE_MISSING",
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "DOCUMENT_NOT_FOUND",
  "AI_BUDGET_EXCEEDED",
);

export const SENTIMENT_TEXT_MAX_LENGTH = 5_000;
export const DOCUMENT_TITLE_MAX_LENGTH = 200;
export const DOCUMENT_CONTENT_MAX_LENGTH = 200_000;
export const QUESTION_MAX_LENGTH = 2_000;

export const aiDocumentSchema = z.object({
  id: documentIdSchema,
  title: z.string(),
  /** pending → indexing → ready (or failed, with an error code). */
  status: z.enum(["pending", "indexing", "ready", "failed"]),
  error: z.string().nullable(),
  chunkCount: z.number().int(),
  /** A few sentences, written after indexing when a model is configured. */
  summary: z.string().nullable(),
  createdBy: userIdSchema.nullable(),
  createdAt: z.date(),
});
export type AiDocument = z.infer<typeof aiDocumentSchema>;

/** One step of a streamed answer. */
const assistantEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("sources"),
    sources: z.array(z.object({ documentId: z.uuid(), title: z.string() })),
  }),
  z.object({
    type: z.literal("done"),
    usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
  }),
  /** The answer stopped: a stable error code (AI_RUN_LIMIT, UPSTREAM_UNAVAILABLE). */
  z.object({ type: z.literal("error"), code: z.string() }),
]);
export type AssistantEvent = z.infer<typeof assistantEventSchema>;

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["AI"], summary });

export const aiContract = {
  /** Each one is a model call. */
  sentiment: route("POST", "/ai/sentiment", "Classify the sentiment of a text")
    .meta({ rateLimit: { name: "ai-sentiment", points: 60, windowSeconds: 60, per: "user" } })
    .input(z.object({ text: z.string().trim().min(1).max(SENTIMENT_TEXT_MAX_LENGTH) }))
    .output(
      z.object({
        label: z.enum(["positive", "negative", "neutral"]),
        score: z.number().min(0).max(1),
        model: z.string(),
      }),
    ),
  /** The workspace's documents the assistant answers from, newest first. */
  documents: route("GET", "/ai/documents", "The assistant's documents")
    .meta({ apiKeyScope: "documents:read" })
    .output(z.array(aiDocumentSchema)),
  addDocument: route("POST", "/ai/documents", "Add a document for the assistant")
    .meta({
      apiKeyScope: "documents:write",
      rateLimit: { name: "ai-documents", points: 30, windowSeconds: HOUR_S, per: "user" },
    })
    .input(
      z.object({
        title: z.string().trim().min(1).max(DOCUMENT_TITLE_MAX_LENGTH),
        content: z.string().trim().min(1).max(DOCUMENT_CONTENT_MAX_LENGTH),
      }),
    )
    .output(aiDocumentSchema),
  /** Its creator or a workspace admin (FORBIDDEN otherwise). */
  removeDocument: route("POST", "/ai/documents/{documentId}/remove", "Remove a document")
    .meta({ apiKeyScope: "documents:write", rateLimit: EVERYDAY_WRITES })
    .input(z.object({ documentId: documentIdSchema }))
    .output(z.void()),
  /** Streams an answer from the workspace's documents (AI_BUDGET_EXCEEDED when used up). */
  ask: route("POST", "/ai/answers", "Ask the assistant")
    .meta({ rateLimit: { name: "ai-questions", points: 20, windowSeconds: 60, per: "user" } })
    .input(z.object({ question: z.string().trim().min(1).max(QUESTION_MAX_LENGTH) }))
    .output(eventIterator(assistantEventSchema)),
};
