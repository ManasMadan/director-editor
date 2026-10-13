import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, standIn } from "../../test/stand-in";
import { useActiveWorkspaceQuery } from "./active-workspace";
import { createAppAuthClient } from "./client";
import { useInvitationQuery } from "./invitation";
import { useOAuthClientQuery } from "./oauth-client";
import { usePasskeysQuery } from "./passkeys";
import { authKeys } from "./query";
import { useSessionsQuery } from "./sessions";
import { useWorkspacesQuery } from "./workspaces";

// The API's auth endpoints, as far as these queries see them: each path answers what
// `answers` holds for it (a status and a body), and every request is recorded.
let server: Server;
let baseUrl: string;
// A new client per test: better-auth's client keeps the session it last fetched.
let auth: ReturnType<typeof createAppAuthClient>;
let answers: Record<string, [number, unknown]>;
const requests: string[] = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "";
    requests.push(url);
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
  requests.length = 0;
});

const api = standIn(() => ({}));
const signedIn = (activeOrganizationId: string | null) => ({
  session: { id: "session-1", userId: "user-1", activeOrganizationId },
  user: { id: "user-1", name: "Ada", email: "ada@example.com" },
});

describe("the auth queries", () => {
  it("list the user's workspaces", async () => {
    answers["/organization/list"] = [200, [{ id: "org-1", name: "Acme", slug: "acme" }]];
    const { result } = renderHook(() => useWorkspacesQuery(auth), api);
    await vi.waitFor(() => expect(result.current.data?.map((w) => w.name)).toEqual(["Acme"]));
  });

  it("show a refusal as an error, not as an empty answer", async () => {
    answers["/organization/list"] = [403, { code: "FORBIDDEN", message: "no" }];
    const { result } = renderHook(() => useWorkspacesQuery(auth), api);
    await vi.waitFor(() => expect(result.current.error).toMatchObject({ code: "FORBIDDEN" }));
    expect(result.current.data).toBeUndefined();
  });

  it("load the active workspace and the user's role in it", async () => {
    answers["/get-session"] = [200, signedIn("org-1")];
    answers["/organization/get-full-organization"] = [
      200,
      {
        id: "org-1",
        name: "Acme",
        members: [{ userId: "user-1", role: "admin" }],
        invitations: [],
      },
    ];
    const { result } = renderHook(() => useActiveWorkspaceQuery(auth), api);
    await vi.waitFor(() => expect(result.current.data?.name).toBe("Acme"));
    expect(result.current).toMatchObject({ role: "admin", userId: "user-1", isAdmin: true });
  });

  it("ask for no workspace while none is active, and grant nothing", async () => {
    answers["/get-session"] = [200, signedIn(null)];
    const { result } = renderHook(() => useActiveWorkspaceQuery(auth), api);
    await vi.waitFor(() => expect(result.current.userId).toBe("user-1"));
    expect(result.current).toMatchObject({ fetchStatus: "idle", role: null, isAdmin: false });
    expect(requests.some((url) => url.includes("get-full-organization"))).toBe(false);
  });

  it("open an invitation by its id", async () => {
    answers["/organization/get-invitation?id=inv-1"] = [
      200,
      { id: "inv-1", organizationName: "Acme" },
    ];
    const { result } = renderHook(() => useInvitationQuery(auth, "inv-1"), api);
    await vi.waitFor(() => expect(result.current.data).toMatchObject({ organizationName: "Acme" }));
  });

  it("name the app asking for OAuth access, once there is one", async () => {
    answers["/oauth2/public-client?client_id=app-1"] = [
      200,
      { client_id: "app-1", client_name: "Notes" },
    ];
    const none = renderHook(() => useOAuthClientQuery(auth, null), api);
    expect(none.result.current.fetchStatus).toBe("idle");
    const { result } = renderHook(() => useOAuthClientQuery(auth, "app-1"), api);
    await vi.waitFor(() => expect(result.current.data).toMatchObject({ client_name: "Notes" }));
  });

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

  it("keep every workspace query under one key, so refreshing them is one call", () => {
    const all = authKeys.workspaces();
    for (const key of [authKeys.workspaceList(), authKeys.activeWorkspace("org-1")]) {
      expect(key.slice(0, all.length)).toEqual([...all]);
    }
  });
});
