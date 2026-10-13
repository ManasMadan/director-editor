/**
 * The api's MCP server through the official MCP client, with tokens from the real OAuth
 * flow (see oauth-client.ts): discovery challenges, tools per scope, acting as the user
 * in the approved workspace, and access ending the moment the grant does.
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AI_MCP_PATH } from "@repo/contracts/mcp";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Harness, startApi, takeNotification } from "./harness";
import { oauthClient } from "./oauth-client";

let harness: Harness;
beforeAll(async () => {
  harness = await startApi(3);
});
afterAll(() => harness?.close());

const { site, resource, signedIn, client, grant } = oauthClient(() => harness);
const endpoint = () => new URL("/api/mcp", harness.baseUrl);
const metadataUrl = () => `${site()}/.well-known/oauth-protected-resource/api/mcp`;

async function connect(accessToken: string) {
  const mcp = new Client({ name: "integration-test", version: "1.0.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(endpoint(), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  return mcp;
}

/** A signed-in user and an MCP client connected with a token for their active workspace. */
async function connected(scope = "openid offline_access todos:read todos:write") {
  const user = await signedIn();
  const clientId = await client();
  const tokens = await grant(user.session, clientId, { scope });
  return { ...user, clientId, tokens, mcp: await connect(tokens.access_token) };
}

const text = (result: unknown) =>
  ((result as CallToolResult).content[0] as { type: "text"; text: string }).text;
const json = <T>(result: unknown) => JSON.parse(text(result)) as T;

/** A raw JSON-RPC request, to see the HTTP answer a client gets before any MCP logic. */
function post(headers: Record<string, string> = {}) {
  return fetch(endpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("authentication", () => {
  it("challenges a request without a token, pointing at the resource metadata", async () => {
    const response = await post();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${metadataUrl()}"`,
    );
  });

  it("refuses an invalid token with invalid_token", async () => {
    const response = await post({ authorization: "Bearer not-a-token" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("refuses a token issued for the other MCP server", async () => {
    const user = await signedIn();
    const tokens = await grant(user.session, await client(), {
      scope: "openid documents:read",
      resource: resource(AI_MCP_PATH),
    });
    const response = await post({ authorization: `Bearer ${tokens.access_token}` });
    expect(response.status).toBe(401);
  });
});

describe("tools", () => {
  it("offers the todo tools the token's scopes allow", async () => {
    const { mcp } = await connected();
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_todo",
      "delete_todo",
      "list_todos",
      "set_todo_completed",
    ]);
    expect(tools.find((tool) => tool.name === "list_todos")?.annotations?.readOnlyHint).toBe(true);
    await mcp.close();
  });

  it("a read-only grant only sees the read tool", async () => {
    const { mcp, session } = await connected("openid todos:read");
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(["list_todos"]);
    // The write tools don't exist for this token, so there's nothing to call.
    const call = await mcp.callTool({ name: "add_todo", arguments: { title: "Not allowed" } });
    expect(call.isError).toBe(true);
    expect(text(call)).toContain("Tool add_todo not found");
    expect((await session.rpc.todo.list({})).items).toEqual([]);
    await mcp.close();
  });

  it("adds, lists, completes and deletes todos as the user, in the approved workspace", async () => {
    const { mcp, session, me } = await connected();
    const added = json<{ id: string; title: string; version: number }>(
      await mcp.callTool({ name: "add_todo", arguments: { title: "Written by an agent" } }),
    );
    expect(added.title).toBe("Written by an agent");
    // Recorded like any other change: by the user, in the workspace (the audit log's source).
    const db = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await db.connect();
    const { rows } = await db
      .query<{ actor_id: string; org_id: string }>(
        "SELECT actor_id, org_id FROM app.outbox_event WHERE name = 'todo.created.v1' AND key = $1",
        [added.id],
      )
      .finally(() => db.end());
    expect(rows).toEqual([{ actor_id: me.id, org_id: me.activeOrganizationId }]);
    // The web app sees it: same workspace, same data.
    expect((await session.rpc.todo.list({})).items.map((todo) => todo.id)).toEqual([added.id]);

    const listed = json<{ items: { id: string }[] }>(
      await mcp.callTool({ name: "list_todos", arguments: {} }),
    );
    expect(listed.items.map((todo) => todo.id)).toEqual([added.id]);

    const completed = json<{ completed: boolean }>(
      await mcp.callTool({
        name: "set_todo_completed",
        arguments: { id: added.id, completed: true, version: added.version },
      }),
    );
    expect(completed.completed).toBe(true);

    await mcp.callTool({ name: "delete_todo", arguments: { id: added.id } });
    expect((await session.rpc.todo.list({})).items).toEqual([]);
    await mcp.close();
  });

  it("reports failures as tool errors the model can act on", async () => {
    const { mcp } = await connected();
    const added = json<{ id: string; version: number }>(
      await mcp.callTool({ name: "add_todo", arguments: { title: "Changes twice" } }),
    );
    await mcp.callTool({
      name: "set_todo_completed",
      arguments: { id: added.id, completed: true, version: added.version },
    });
    const stale = await mcp.callTool({
      name: "set_todo_completed",
      arguments: { id: added.id, completed: false, version: added.version },
    });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toMatch(/^TODO_VERSION_CONFLICT: /);

    const missing = await mcp.callTool({ name: "delete_todo", arguments: { id: randomUUID() } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^TODO_NOT_FOUND: /);
    await mcp.close();
  });

  it("answers an unexpected failure as INTERNAL, with the request id to look it up by", async () => {
    const { mcp } = await connected();
    const { TodoService } = await import("../src/modules/todo");
    vi.spyOn(harness.app.get(TodoService), "list").mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined"),
    );
    const failed = await mcp.callTool({ name: "list_todos", arguments: {} });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toMatch(/^INTERNAL: the tool failed \(request id [^)]+\)\.$/);
    await mcp.close();
  });

  it("validates tool input with the contract's schema", async () => {
    const { mcp } = await connected();
    const invalid = await mcp.callTool({ name: "add_todo", arguments: { title: "" } });
    expect(invalid.isError).toBe(true);
    await mcp.close();
  });

  it("only ever sees the approved workspace's data", async () => {
    const owner = await connected();
    await owner.mcp.callTool({ name: "add_todo", arguments: { title: "Owner's secret" } });
    const other = await connected();
    const listed = json<{ items: unknown[] }>(
      await other.mcp.callTool({ name: "list_todos", arguments: {} }),
    );
    expect(listed.items).toEqual([]);
    await owner.mcp.close();
    await other.mcp.close();
  });
});

describe("the grant", () => {
  it("disconnecting the app cuts it off on the next request", async () => {
    const { mcp, session, tokens } = await connected();
    await mcp.listTools();
    const [app] = await session.rpc.apps.list();
    await session.rpc.apps.disconnect({ id: app?.id as string });
    const response = await post({ authorization: `Bearer ${tokens.access_token}` });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("disconnected");
    await mcp.close();
  });

  it("leaving the workspace cuts the app off", async () => {
    const owner = await signedIn();
    const org = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    const member = await signedIn();
    await owner.session.auth("/organization/invite-member", {
      email: member.email,
      role: "member",
      organizationId: org.body.id,
    });
    const invitation = await takeNotification(harness, "org.invitation", member.email);
    await member.session.auth("/organization/accept-invitation", {
      invitationId: new URL(invitation.data.acceptUrl).pathname.split("/").at(-1),
    });
    await member.session.auth("/organization/set-active", { organizationId: org.body.id });
    const tokens = await grant(member.session, await client());
    expect((await post({ authorization: `Bearer ${tokens.access_token}` })).status).toBe(200);

    await owner.session.auth("/organization/remove-member", {
      memberIdOrEmail: member.email,
      organizationId: org.body.id,
    });
    expect((await post({ authorization: `Bearer ${tokens.access_token}` })).status).toBe(401);
  });

  it("limits calls per app and user", async () => {
    const { tokens, mcp } = await connected();
    await mcp.close();
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) {
      statuses.push((await post({ authorization: `Bearer ${tokens.access_token}` })).status);
    }
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(60);
    expect(statuses.at(-1)).toBe(429);
  });
});
