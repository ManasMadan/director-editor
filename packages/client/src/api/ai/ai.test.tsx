import { ORPCError } from "@orpc/client";
import type { AiDocument, AssistantEvent } from "@repo/contracts/api";
import { documentIdSchema } from "@repo/contracts/ids";
import { afterEach, describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn, until } from "../../../test/stand-in";
import { useAddDocumentMutation } from "./add-document";
import { useAssistant } from "./assistant";
import { useAiDocumentsQuery } from "./documents";
import { useRemoveDocumentMutation } from "./remove-document";
import { useAiSentimentMutation } from "./sentiment";

const document = (n: number, status: AiDocument["status"]): AiDocument => ({
  id: documentIdSchema.parse(id(n)),
  title: `Doc ${n}`,
  status,
  error: null,
  chunkCount: 0,
  summary: null,
  createdBy: null,
  createdAt: new Date(0),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the assistant's documents", () => {
  it("adds and removes documents, refetching the list after each", async () => {
    let documents = [document(1, "ready")];
    const api = standIn((os) => ({
      ai: {
        documents: os.ai.documents.handler(() => documents),
        addDocument: os.ai.addDocument.handler(({ input }) => {
          const added = { ...document(2, "ready"), title: input.title };
          documents = [...documents, added];
          return added;
        }),
        removeDocument: os.ai.removeDocument.handler(({ input }) => {
          documents = documents.filter((d) => d.id !== input.documentId);
        }),
      },
    }));
    const { result } = renderHook(
      () => ({
        documents: useAiDocumentsQuery(),
        add: useAddDocumentMutation(),
        remove: useRemoveDocumentMutation(),
      }),
      api,
    );
    const titles = () => result.current.documents.data?.map((d) => d.title);
    await vi.waitFor(() => expect(titles()).toEqual(["Doc 1"]));
    await result.current.add.mutateAsync({ title: "Handbook", content: "Refunds take a week." });
    await vi.waitFor(() => expect(titles()).toEqual(["Doc 1", "Handbook"]));
    await result.current.remove.mutateAsync({ documentId: id(1) });
    await vi.waitFor(() => expect(titles()).toEqual(["Handbook"]));
  });

  it("looks again every few seconds while one is being prepared, and stops once ready", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const statuses: AiDocument["status"][] = ["pending", "indexing", "ready"];
    let listed = 0;
    const api = standIn((os) => ({
      ai: {
        documents: os.ai.documents.handler(() => [
          document(1, statuses[Math.min(listed++, statuses.length - 1)] ?? "ready"),
        ]),
      },
    }));
    const { result } = renderHook(() => useAiDocumentsQuery(), api);
    await until(() => expect(result.current.data?.[0]?.status).toBe("pending"));
    await vi.advanceTimersByTimeAsync(5_000);
    await until(() => expect(result.current.data?.[0]?.status).toBe("indexing"));
    await vi.advanceTimersByTimeAsync(5_000);
    await until(() => expect(result.current.data?.[0]?.status).toBe("ready"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listed).toBe(3);
  });
});

describe("sentiment", () => {
  it("classifies a text", async () => {
    const api = standIn((os) => ({
      ai: {
        sentiment: os.ai.sentiment.handler(({ input }) => ({
          label: input.text.includes("love") ? "positive" : "neutral",
          score: 0.9,
          model: "local",
        })),
      },
    }));
    const { result } = renderHook(() => useAiSentimentMutation(), api);
    await expect(result.current.mutateAsync({ text: "I love it" })).resolves.toMatchObject({
      label: "positive",
    });
  });
});

describe("useAssistant", () => {
  /**
   * Answers with `events`. With `held`, each event of the first answer waits for
   * `release()`, so a test can act while it streams.
   */
  function assistantApi(
    events: AssistantEvent[],
    { held = false, streamsAfterAbort = false } = {},
  ) {
    const gates: PromiseWithResolvers<void>[] = [];
    const next = () => {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      return gate;
    };
    let answering = 0;
    const api = standIn(
      (os) => ({
        ai: {
          // A refusal comes before the stream opens, as the API's checks run first.
          ask: os.ai.ask.handler(({ input }) => {
            const holds = held && ++answering === 1;
            if (input.question === "refuse") {
              throw new ORPCError("AI_BUDGET_EXCEEDED");
            }
            return (async function* () {
              for (const event of events) {
                if (holds) {
                  await next().promise;
                }
                yield event;
              }
            })();
          }),
        },
      }),
      { streamsAfterAbort },
    );
    return {
      api,
      /** Lets the next held event through. */
      release: async () => {
        await until(() => expect(gates.length).toBeGreaterThan(0));
        gates.shift()?.resolve();
      },
    };
  }

  const answer: AssistantEvent[] = [
    { type: "sources", sources: [{ documentId: id(1), title: "Handbook" }] },
    { type: "text", text: "Refunds take " },
    { type: "text", text: "a week." },
    { type: "done", usage: { inputTokens: 10, outputTokens: 4 } },
  ];

  it("streams an answer with its sources", async () => {
    const { api } = assistantApi(answer);
    const { result } = renderHook(() => useAssistant(), api);
    expect(result.current.status).toBe("idle");
    await result.current.ask("How long do refunds take?");
    await vi.waitFor(() =>
      expect(result.current).toMatchObject({
        status: "done",
        answer: "Refunds take a week.",
        sources: [{ documentId: id(1), title: "Handbook" }],
        error: null,
      }),
    );
  });

  it("reports an error the stream sends, and one the API throws", async () => {
    const { api } = assistantApi([{ type: "error", code: "UPSTREAM_UNAVAILABLE" }]);
    const { result } = renderHook(() => useAssistant(), api);
    await result.current.ask("Hello?");
    await vi.waitFor(() =>
      expect(result.current).toMatchObject({
        status: "error",
        error: { code: "UPSTREAM_UNAVAILABLE" },
      }),
    );
    await result.current.ask("refuse");
    await vi.waitFor(() => expect(result.current.error).toBeInstanceOf(ORPCError));
    expect(result.current.status).toBe("error");
    expect((result.current.error as ORPCError<string, unknown>).code).toBe("AI_BUDGET_EXCEEDED");
  });

  it("stops the answer when asked, keeping what came so far", async () => {
    const server = assistantApi(answer, { held: true });
    const { result } = renderHook(() => useAssistant(), server.api);
    const asking = result.current.ask("How long do refunds take?");
    await server.release();
    await server.release();
    await vi.waitFor(() => expect(result.current.answer).toBe("Refunds take "));
    result.current.stop();
    await vi.waitFor(() => expect(result.current.status).toBe("done"));
    await server.release();
    await asking;
    expect(result.current.answer).toBe("Refunds take ");
    // Stopping again, or when nothing streams, changes nothing.
    result.current.stop();
    expect(result.current.status).toBe("done");
  });

  it("drops the previous answer when asked again", async () => {
    const server = assistantApi(answer, { held: true });
    const { result } = renderHook(() => useAssistant(), server.api);
    const first = result.current.ask("First?");
    await server.release();
    await vi.waitFor(() => expect(result.current.sources).toHaveLength(1));
    const second = result.current.ask("Second?");
    // The first answer ends without a word more, and the second starts from nothing.
    await first;
    await second;
    await vi.waitFor(() =>
      expect(result.current).toMatchObject({ status: "done", answer: "Refunds take a week." }),
    );
  });

  it("ignores what an answer it dropped still sends", async () => {
    const server = assistantApi(answer, { held: true, streamsAfterAbort: true });
    const { result } = renderHook(() => useAssistant(), server.api);
    const first = result.current.ask("First?");
    await server.release();
    await vi.waitFor(() => expect(result.current.sources).toHaveLength(1));
    result.current.stop();
    await server.release();
    await first;
    await vi.waitFor(() => expect(result.current).toMatchObject({ status: "done", answer: "" }));
  });

  it("stops streaming when unmounted", async () => {
    const server = assistantApi(answer, { held: true });
    const { result, unmount } = renderHook(() => useAssistant(), server.api);
    const asking = result.current.ask("Hello?");
    await server.release();
    unmount();
    await asking;
    expect(result.current.answer).toBe("");
  });
});
