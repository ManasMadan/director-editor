/**
 * The API, faked at fetch: the app's real auth client (better-auth) and API client (oRPC)
 * run unchanged, and each request is answered by the handler for its path the way the
 * server answers it: plain JSON under /api/auth, `{ json }` bodies under /rpc. Unless a
 * test says otherwise the server has no session, no optional features, no todos and no
 * passkeys; `server.session` is what get-session answers with.
 *
 *   const calls = fakeApi({ "/api/auth/sign-in/email": () => fail(401, "INVALID_EMAIL_OR_PASSWORD") });
 */
type Input = Record<string, unknown>;
type Handler = (input: Input) => unknown;

/** A handler's answer for a failed request: the status and error code the server sends. */
class Failure {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly data: Record<string, unknown> = {},
  ) {}
}
export const fail = (status: number, code?: string, data?: Record<string, unknown>) =>
  new Failure(status, code, data);

export interface Call {
  path: string;
  input: Input;
  headers: Headers;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const server: { session: Session | null } = { session: null };

/** A handler's result as the API's response: oRPC's envelope for /rpc, plain for auth. */
function answer(result: unknown, rpc: boolean) {
  if (result instanceof Response) {
    return result;
  }
  if (result instanceof Failure) {
    const { status, code, data } = result;
    return json(
      status,
      rpc ? { json: { defined: true, code, status, message: "", data } } : { code },
    );
  }
  return json(200, rpc ? { json: result } : (result ?? null));
}

export function fakeApi(overrides: Record<string, Handler> = {}): Call[] {
  server.session = null;
  const handlers: Record<string, Handler> = {
    "/api/auth/get-session": () => server.session,
    "/rpc/system/info": () => ({ features: {}, minimumClientVersion: "0.0.0" }),
    "/rpc/todo/list": () => ({ items: [], nextCursor: null }),
    "/api/auth/passkey/list-user-passkeys": () => [],
    ...overrides,
  };
  const calls: Call[] = [];
  jest.mocked(fetch).mockImplementation(async (resource, init) => {
    const request = new Request(resource, init);
    const url = new URL(request.url);
    const rpc = url.pathname.startsWith("/rpc/");
    const text = await request.text();
    const body = (text ? JSON.parse(text) : Object.fromEntries(url.searchParams)) as Input;
    const input = ((rpc ? body.json : body) ?? {}) as Input;
    calls.push({ path: url.pathname, input, headers: request.headers });
    const handler = handlers[url.pathname];
    if (!handler) {
      throw new Error(`No fake answer for ${request.method} ${url.pathname}`);
    }
    return answer(await handler(input), rpc);
  });
  return calls;
}

/** What better-auth's get-session answers for a signed-in user. */
export function aSession(
  user: { locale?: string; email?: string } = {},
  activeOrganizationId = "org-1",
) {
  return {
    session: { id: "session-1", userId: "user-1", token: "token-1", activeOrganizationId },
    user: { id: "user-1", name: "Ada", email: "ada@example.com", emailVerified: true, ...user },
  };
}
export type Session = ReturnType<typeof aSession>;
