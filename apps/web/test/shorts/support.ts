/**
 * What the mock YouTube can't answer (an empty feed, a second page, comments turned off,
 * a short whose counts are hidden): the page's calls to `/rpc/shorts/<procedure>` go to
 * the API as usual, and `edit` changes its answer before the page reads it. Dates in an
 * edited answer stay strings; nothing that reads one is edited here.
 *
 *   editShorts<Feed>("feed", (feed) => ({ ...feed, items: [] }));
 */
import type { Short } from "@repo/contracts/api";
import { onTestFinished, vi } from "vitest";

type Input = Record<string, unknown>;

/** The procedure's input, as oRPC's link sends it (a POST body, or GET's `data`). */
async function inputOf(request: Request): Promise<Input> {
  const raw =
    request.method === "GET"
      ? new URL(request.url).searchParams.get("data")
      : await request.clone().text();
  return (raw ? (JSON.parse(raw) as { json?: Input }).json : undefined) ?? {};
}

export function editShorts<T>(procedure: string, edit: (answer: T, input: Input) => unknown) {
  const fetch = window.fetch;
  const spy = vi.spyOn(window, "fetch").mockImplementation(async (...args) => {
    const [target] = args;
    if (!(target instanceof Request) || !target.url.endsWith(`/rpc/shorts/${procedure}`)) {
      return fetch(...args);
    }
    const input = await inputOf(target);
    const response = await fetch(...args);
    const { json } = (await response.json()) as { json: T };
    return new Response(JSON.stringify({ json: edit(json, input) }), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });
  onTestFinished(() => spy.mockRestore());
}

/** A page of the Shorts feed, as `shorts.feed` answers it. */
export interface Feed {
  items: Short[];
  nextPageToken: string | null;
}
