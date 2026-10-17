import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, standIn } from "../../test/stand-in";
import { createAppAuthClient } from "./client";
import { usePasskeysQuery } from "./passkeys";
import { useSessionsQuery } from "./sessions";

// The API's auth endpoints, as far as these queries see them: each path answers what
// `answers` holds for it (a status and a body).
let server: Server;
let baseUrl: string;
// A new client per test: better-auth's client keeps the session it last fetched.
let auth: ReturnType<typeof createAppAuthClient>;
let answers: Record<string, [number, unknown]>;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "";
    const [status, body] = answers[url.replace(/^\/api\/auth/, "")] ?? [404, null];
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  auth = createAppAuthClient({ baseUrl });
  answers = {};
});

const api = standIn(() => ({}));

describe("the auth queries", () => {
  it("list the user's sessions and passkeys", async () => {
    answers["/list-sessions"] = [200, [{ id: "session-1" }, { id: "session-2" }]];
    answers["/passkey/list-user-passkeys"] = [200, [{ id: "passkey-1", name: "Laptop" }]];
    const { result } = renderHook(
      () => ({ sessions: useSessionsQuery(auth), passkeys: usePasskeysQuery(auth) }),
      api,
    );
    await vi.waitFor(() => {
      expect(result.current.sessions.data?.map((s) => s.id)).toEqual(["session-1", "session-2"]);
      expect(result.current.passkeys.data?.map((p) => p.name)).toEqual(["Laptop"]);
    });
  });

  it("show a refusal as an error, not as an empty answer", async () => {
    answers["/list-sessions"] = [403, { code: "SESSION_EXPIRED", message: "no" }];
    const { result } = renderHook(() => useSessionsQuery(auth), api);
    await vi.waitFor(() => expect(result.current.error).toMatchObject({ code: "SESSION_EXPIRED" }));
    expect(result.current.data).toBeUndefined();
  });
});
