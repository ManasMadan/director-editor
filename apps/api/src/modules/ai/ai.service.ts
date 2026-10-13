/**
 * The AI features, on top of the Python service through its generated client
 * (packages/ai-client). This API has authenticated the user and checked their
 * membership; each call to the service carries a token naming them and the workspace.
 *
 * Service errors are mapped to this API's error codes; anything unexpected becomes
 * UPSTREAM_UNAVAILABLE, never the service's own message.
 */

import { Injectable } from "@nestjs/common";
import { type AiCaller, AiServiceError, createAiClient } from "@repo/ai-client";
import type { AiDocument, AssistantEvent } from "@repo/contracts/api";
import type { ErrorCode } from "@repo/contracts/errors";
import {
  type DocumentId,
  documentIdSchema,
  type OrgId,
  type UserId,
  userIdSchema,
} from "@repo/contracts/ids";
import { canManageWorkspace, type OrgRole } from "@repo/contracts/roles";
import {
  AppError,
  currentContext,
  describeError,
  InjectPinoLogger,
  PinoLogger,
} from "@repo/nest-common";
import { env } from "../../env";

// Error codes the service may answer with that clients understand.
const PASSED_ON = new Set<ErrorCode>([
  "DOCUMENT_NOT_FOUND",
  "AI_BUDGET_EXCEEDED",
  "FEATURE_DISABLED",
  "VALIDATION_FAILED",
]);

@Injectable()
export class AiService {
  private readonly client =
    env.AI_URL && env.AI_SERVICE_SECRET
      ? createAiClient({ baseUrl: env.AI_URL, secret: env.AI_SERVICE_SECRET })
      : null;

  constructor(@InjectPinoLogger(AiService.name) private readonly log: PinoLogger) {}

  private get ai() {
    if (!this.client) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "ai" } });
    }
    return this.client;
  }

  private caller(userId: UserId, orgId: OrgId): AiCaller {
    return { userId, orgId, requestId: currentContext()?.requestId };
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw toAppError(error);
    }
  }

  async sentiment(userId: UserId, orgId: OrgId, text: string) {
    return this.call(() => this.ai.sentiment(this.caller(userId, orgId), text));
  }

  async documents(userId: UserId, orgId: OrgId): Promise<AiDocument[]> {
    const rows = await this.call(() => this.ai.listDocuments(this.caller(userId, orgId)));
    return rows.map(toDocument);
  }

  async addDocument(userId: UserId, orgId: OrgId, input: { title: string; content: string }) {
    const row = await this.call(() => this.ai.createDocument(this.caller(userId, orgId), input));
    return toDocument(row);
  }

  /** A member may remove their own documents; owners and admins any. */
  async removeDocument(userId: UserId, orgId: OrgId, role: OrgRole, documentId: DocumentId) {
    if (!canManageWorkspace(role)) {
      const document = (await this.documents(userId, orgId)).find((d) => d.id === documentId);
      if (!document) {
        throw new AppError("DOCUMENT_NOT_FOUND");
      }
      if (document.createdBy !== userId) {
        throw new AppError("FORBIDDEN");
      }
    }
    await this.call(() => this.ai.deleteDocument(this.caller(userId, orgId), documentId));
  }

  /**
   * Starts an answer: the budget and an unavailable service are refused here, as
   * typed errors, before the stream begins. A failure midway (the connection drops)
   * ends the stream with an `error` event, which the contract has for exactly that.
   */
  async ask(
    userId: UserId,
    orgId: OrgId,
    question: string,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<AssistantEvent, void, unknown>> {
    const stream = await this.call(() =>
      this.ai.answer(this.caller(userId, orgId), question, signal),
    );
    const log = this.log;
    return (async function* () {
      try {
        yield* stream;
      } catch (error) {
        if (signal?.aborted) {
          return; // the client went away
        }
        // The client hears the service failed either way; the log says which it was.
        log[streamFailureLevel(error)]({ err: describeError(error) }, "assistant stream failed");
        yield { type: "error", code: "UPSTREAM_UNAVAILABLE" } as const;
      }
    })();
  }
}

function toDocument(row: {
  id: string;
  title: string;
  status: AiDocument["status"];
  error: string | null;
  chunkCount: number;
  summary: string | null;
  createdBy: string | null;
  createdAt: string;
}): AiDocument {
  return {
    ...row,
    id: documentIdSchema.parse(row.id),
    createdBy: userIdSchema.nullable().parse(row.createdBy),
    createdAt: new Date(row.createdAt),
  };
}

/**
 * How loudly to log an answer that broke off: the service or the connection failing is a
 * warning (it happens); anything else, like the stream breaking its contract, is a bug.
 */
export function streamFailureLevel(error: unknown): "warn" | "error" {
  const dropped =
    error instanceof AiServiceError ||
    (error instanceof TypeError && error.message === "terminated");
  return dropped ? "warn" : "error";
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof AiServiceError && PASSED_ON.has(error.code)) {
    return new AppError(error.code, { params: error.params });
  }
  return new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "ai" }, cause: error });
}
