/**
 * What the hooks' tests run against: the API's contract implemented in memory, answering
 * over oRPC's real wire protocol through the client's `fetch` option, so every input and
 * output is serialized and validated both ways as it is against apps/api. A test
 * implements only the procedures it calls; the API's own behaviour is apps/api's tests.
 *
 *   const api = standIn((os) => ({ user: { me: os.user.me.handler(() => me) } }));
 *   const { result } = renderHook(() => useMeQuery(), api);
 *   await vi.waitFor(() => expect(result.current.data).toEqual(me));
 */
import { type AnyRouter, implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { contract } from "@repo/contracts/api";
import { act } from "react";
import { create } from "react-test-renderer";
import { ApiProvider, type ApiProviderProps } from "../src/provider";

const os = implement(contract);
export type Implement = typeof os;

export interface StandIn {
  fetch: typeof fetch;
  /** The procedures called so far, in order: `"todo/list"`. */
  calls: string[];
}

export function standIn(
  build: (os: Implement) => AnyRouter,
  {
    /** Keep delivering a response after its request is aborted, as not every fetch fails it. */
    streamsAfterAbort = false,
  } = {},
): StandIn {
  const handler = new RPCHandler(build(os));
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(new URL(request.url).pathname.replace(/^\/rpc\//, ""));
    const { matched, response } = await handler.handle(request, { prefix: "/rpc" });
    if (!matched) {
      return new Response("no such procedure", { status: 404 });
    }
    if (!response.body || streamsAfterAbort) {
      return response;
    }
    // As a browser's fetch does, aborting the request fails a response still streaming.
    const { readable, writable } = new TransformStream();
    response.body.pipeTo(writable, { signal: request.signal }).catch(() => undefined);
    return new Response(readable, response);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

/**
 * Renders `hook` inside an ApiProvider talking to `api`; `result.current` is its latest
 * return value.
 */
export function renderHook<T>(
  hook: () => T,
  api: StandIn,
  props: Omit<ApiProviderProps, "children" | "options"> = {},
) {
  const result = { current: undefined as T };
  function Probe() {
    result.current = hook();
    return null;
  }
  const tree = () => (
    <ApiProvider options={{ baseUrl: "http://api.test", fetch: api.fetch }} {...props}>
      <Probe />
    </ApiProvider>
  );
  const renderer = now(() => create(tree()));
  return {
    result,
    /** Runs the hook again, e.g. after changing a value it reads. */
    rerender: () => now(() => renderer.update(tree())),
    unmount: () => now(() => renderer.unmount()),
  };
}

/**
 * Renders, updates or unmounts before returning, effects and cleanups included. Only
 * inside `act` does React expect it: the tests wait for everything else as it happens.
 */
function now<T>(render: () => T): T {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    let rendered: T | undefined;
    act(() => {
      rendered = render();
    });
    return rendered as T;
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

/** Fixed ids, so assertions can name them. */
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Waits for `check` to pass, like `vi.waitFor`, but without moving fake timers: under
 * `vi.useFakeTimers()` a test advances the clock itself, to the millisecond.
 */
export async function until(check: () => void) {
  for (let attempt = 0; ; attempt++) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt === 500) {
        throw error;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
