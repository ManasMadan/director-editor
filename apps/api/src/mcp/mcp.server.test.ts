import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { orgIdSchema, userIdSchema } from "@repo/contracts/ids";
import { AppError, runWithContext } from "@repo/nest-common";
import { describe, expect, it, vi } from "vitest";
import type { TodoService } from "../modules/todo";
import { createMcpServer } from "./mcp.server";

async function connect(scopes: string[], list: () => Promise<unknown> = async () => []) {
  const logError = vi.fn();
  const server = createMcpServer(
    {
      userId: userIdSchema.parse(randomUUID()),
      orgId: orgIdSchema.parse(randomUUID()),
      clientId: "c",
      scopes: new Set(scopes),
      token: "t",
    },
    {
      todos: { list } as unknown as TodoService,
      describeError: async (error) => `described ${error.code}`,
      logError,
      release: "test",
    },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return { client, logError };
}

async function callListTodos(list: () => Promise<unknown>, requestId: string | null = "req-1") {
  const { client, logError } = await connect(["todos:read"], list);
  const call = () => client.callTool({ name: "list_todos", arguments: { limit: 5 } });
  const result = await (requestId ? runWithContext({ requestId }, call) : call());
  await client.close();
  return { result, logError };
}

describe("MCP tool failures", () => {
  it("tell the model what went wrong, for a known error", async () => {
    const { result, logError } = await callListTodos(async () => {
      throw new AppError("RATE_LIMITED", { params: { retryAfterSeconds: 3 } });
    });
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "RATE_LIMITED: described RATE_LIMITED" }],
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("are logged, and reach the client as INTERNAL without any internals", async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'secret')");
    const { result, logError } = await callListTodos(async () => {
      throw bug;
    });
    expect(logError).toHaveBeenCalledWith(bug);
    expect(result).toMatchObject({ isError: true });
    const text = JSON.stringify(result);
    expect(text).toContain("INTERNAL: the tool failed");
    expect(text).not.toContain("secret");
  });

  it("have no request id to give outside a request", async () => {
    const { result } = await callListTodos(async () => {
      throw new Error("boom");
    }, null);
    expect(result).toMatchObject({ content: [{ text: "INTERNAL: the tool failed." }] });
  });
});

describe("MCP tools", () => {
  it("are only those the token's scopes allow", async () => {
    const { client } = await connect(["todos:write"]);
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((tool) => tool.name)).not.toContain("list_todos");
    expect(tools.map((tool) => tool.name)).toContain("add_todo");
  });
});
