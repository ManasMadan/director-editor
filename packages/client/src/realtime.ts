/**
 * Live updates: one realtime stream per signed-in tab, reconnecting on its own.
 *
 *   useLiveUpdates(activeOrganizationId);   // once, near the app root (web and mobile)
 *
 * Messages only say what changed, so each maps to a refetch of the affected queries.
 * After any reconnect everything live is refetched too, since messages may have been
 * missed while disconnected.
 *
 * The reconnect loop is written out rather than oRPC's ClientRetryPlugin, which does
 * retry streams: the plugin would sit on every call's link for this one stream, and
 * its wait between attempts ignores the abort signal, so an unmounted tab would keep a
 * timer (up to 30s) and then try once more.
 */
import type { RealtimeMessage } from "@repo/contracts/realtime";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { errorCode } from "./errors";
import { useApi } from "./provider";

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Half the delay plus up to as much again at random: tabs that lost the stream together
 * (a deploy) come back spread out, not all at once.
 */
export const withJitter = (delay: number) => delay / 2 + Math.random() * (delay / 2);

/**
 * Waits `ms`, or until `signal` aborts. Each wait removes its own abort listener, so a
 * long session of reconnects doesn't pile them up on the signal.
 */
export function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

type Client = ReturnType<typeof useApi>["client"];
type Handlers = {
  current: { onMessage: (message: RealtimeMessage) => void; onReconnect: () => void };
};

/**
 * One connection: its messages until it ends. "stop" when it mustn't be retried (aborted,
 * or the app's to handle), "connected" when it opened, "failed" when it never did.
 */
async function listenOnce(
  client: Client,
  handlers: Handlers,
  signal: AbortSignal,
  reconnect: boolean,
) {
  let connected = false;
  try {
    const stream = await client.realtime.subscribe(undefined, { signal });
    connected = true;
    if (reconnect) {
      handlers.current.onReconnect();
    }
    for await (const message of stream) {
      handlers.current.onMessage(message);
    }
  } catch (error) {
    if (signal.aborted) {
      return "stop";
    }
    // Signed out or no workspace: the app handles those; don't hammer the API.
    const code = errorCode(error);
    if (code === "UNAUTHENTICATED" || code === "NO_ACTIVE_ORGANIZATION") {
      return "stop";
    }
  }
  return connected ? "connected" : "failed";
}

/** Keeps a connection open until `signal` aborts, waiting longer after each failure. */
async function follow(client: Client, handlers: Handlers, signal: AbortSignal) {
  let delay = RETRY_MIN_MS;
  let first = true;
  while (!signal.aborted) {
    const outcome = await listenOnce(client, handlers, signal, !first);
    if (outcome === "stop") {
      return;
    }
    if (outcome === "connected") {
      first = false;
      delay = RETRY_MIN_MS;
    }
    await abortableSleep(withJitter(delay), signal);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }
}

/** Calls `onMessage` for every realtime message while mounted; `key` changes reopen the stream. */
export function useRealtime(
  onMessage: (message: RealtimeMessage) => void,
  onReconnect: () => void,
  key: unknown,
) {
  const { client } = useApi();
  // The latest handlers, without reopening the stream when they change.
  const handlers = useRef({ onMessage, onReconnect });
  useEffect(() => {
    handlers.current = { onMessage, onReconnect };
  });

  useEffect(() => {
    if (key === null || key === undefined) {
      return;
    }
    const controller = new AbortController();

    void follow(client, handlers, controller.signal);
    return () => controller.abort();
  }, [client, key]);
}

/** Keeps live screens fresh: refetches the queries each message affects. */
export function useLiveUpdates(activeOrganizationId: string | null | undefined) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const refetch = {
    "todos.changed": () => queryClient.invalidateQueries({ queryKey: api.todo.list.key() }),
    "notifications.changed": () =>
      queryClient.invalidateQueries({ queryKey: api.notifications.key() }),
    "files.changed": () => queryClient.invalidateQueries({ queryKey: api.files.key() }),
    "documents.changed": () => queryClient.invalidateQueries({ queryKey: api.ai.documents.key() }),
  } satisfies Record<RealtimeMessage["type"], () => Promise<void>>;

  useRealtime(
    (message) => void refetch[message.type](),
    () => {
      for (const run of Object.values(refetch)) {
        void run();
      }
    },
    activeOrganizationId,
  );
}
