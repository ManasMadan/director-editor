/**
 * The assistant: streamed answers from the workspace's documents.
 *
 *   const assistant = useAssistant();
 *   assistant.ask("How long do refunds take?");   // assistant.answer fills in as it streams
 */
import type { AssistantEvent } from "@repo/contracts/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../provider";

type Source = Extract<AssistantEvent, { type: "sources" }>["sources"][number];

export interface AssistantState {
  status: "idle" | "streaming" | "done" | "error";
  answer: string;
  sources: Source[];
  /** An error code: thrown by the API (budget, rate limit) or reported by the stream. */
  error: unknown;
}

const IDLE: AssistantState = { status: "idle", answer: "", sources: [], error: null };

/** Streams answers; asking again (or unmounting) stops the previous one. */
export function useAssistant() {
  const { client } = useApi();
  const [state, setState] = useState<AssistantState>(IDLE);
  const current = useRef<AbortController | null>(null);

  useEffect(() => () => current.current?.abort(), []);

  const ask = useCallback(
    async (question: string) => {
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      setState({ ...IDLE, status: "streaming" });
      try {
        const stream = await client.ai.ask({ question }, { signal: controller.signal });
        for await (const event of stream) {
          if (controller.signal.aborted) {
            return;
          }
          setState((previous) => {
            switch (event.type) {
              case "text":
                return { ...previous, answer: previous.answer + event.text };
              case "sources":
                return { ...previous, sources: event.sources };
              case "done":
                return { ...previous, status: "done" };
              case "error":
                return { ...previous, status: "error", error: { code: event.code } };
            }
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setState((previous) => ({ ...previous, status: "error", error }));
        }
      }
    },
    [client],
  );

  const stop = useCallback(() => {
    current.current?.abort();
    setState((previous) =>
      previous.status === "streaming" ? { ...previous, status: "done" } : previous,
    );
  }, []);

  return { ...state, ask, stop };
}
