/**
 * The API's input limits match the Python service's (packages/contracts vs the schemas
 * generated from apps/ai's Pydantic models): a request the API accepts must never be
 * one the service refuses, and the other way round.
 */
import { zAssistantRequest, zDocumentCreate, zSentimentRequest } from "@repo/ai-client/schemas";
import {
  DOCUMENT_CONTENT_MAX_LENGTH,
  DOCUMENT_TITLE_MAX_LENGTH,
  QUESTION_MAX_LENGTH,
  SENTIMENT_TEXT_MAX_LENGTH,
} from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import * as z from "zod";

function maxLength(schema: z.ZodType, field: string) {
  const json = z.toJSONSchema(schema) as { properties: Record<string, { maxLength?: number }> };
  return json.properties[field]?.maxLength;
}

describe("limits shared with the AI service", () => {
  it("match the Python models", () => {
    expect(maxLength(zSentimentRequest, "text")).toBe(SENTIMENT_TEXT_MAX_LENGTH);
    expect(maxLength(zDocumentCreate, "title")).toBe(DOCUMENT_TITLE_MAX_LENGTH);
    expect(maxLength(zDocumentCreate, "content")).toBe(DOCUMENT_CONTENT_MAX_LENGTH);
    expect(maxLength(zAssistantRequest, "question")).toBe(QUESTION_MAX_LENGTH);
  });
});
