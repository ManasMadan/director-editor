/**
 * The api's MCP server: tools over the active workspace's todos, for one caller.
 *
 * Only allowlisted tools exist, each an explicit adapter over a service method with the
 * contract's own input schema. A server is built per request with just the tools the
 * token's scopes allow, so a read-only grant never even sees the write tools. Tools act
 * as the user, in the token's workspace (row-level security and the audit log apply as
 * for any other request).
 *
 * To add a tool: pick (or add) a scope in packages/contracts/src/mcp.ts, register it
 * below behind that scope, and cover it in test/mcp.integration.test.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTodoInput, deleteTodoInput, setTodoCompletedInput } from "@repo/contracts/api";
import { pageInput } from "@repo/contracts/pagination";
import { AppError, currentContext, isAppError } from "@repo/nest-common";
import type { TodoService } from "../modules/todo";
import type { McpCaller } from "./mcp.tokens";

export interface McpServerDependencies {
  todos: TodoService;
  /** The sentence for an error code, in the caller's language. */
  describeError: (error: AppError) => Promise<string>;
  /** Where an unexpected failure is logged (the client only hears that one happened). */
  logError: (error: unknown) => void;
  release: string;
}

export function createMcpServer(caller: McpCaller, deps: McpServerDependencies) {
  const server = new McpServer({ name: "boilerplate", version: deps.release });
  const { orgId, userId } = caller;

  /**
   * Runs a tool; a known failure becomes a tool error the model can read and act on. An
   * unexpected one is logged and answered as INTERNAL with the request id: rethrown, the
   * SDK would hand its message (a stack's worth of internals) to the client.
   */
  async function run(work: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      const result = await work();
      return {
        content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }) }],
      };
    } catch (error) {
      if (isAppError(error)) {
        return {
          isError: true,
          content: [{ type: "text", text: `${error.code}: ${await deps.describeError(error)}` }],
        };
      }
      deps.logError(error);
      const requestId = currentContext()?.requestId;
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `INTERNAL: the tool failed${requestId ? ` (request id ${requestId})` : ""}.`,
          },
        ],
      };
    }
  }

  if (caller.scopes.has("todos:read")) {
    server.registerTool(
      "list_todos",
      {
        title: "List todos",
        description:
          "The workspace's todos, newest first. Pass `cursor` from the previous page's `nextCursor` for more.",
        inputSchema: pageInput,
        annotations: { readOnlyHint: true },
      },
      (input) => run(() => deps.todos.list(orgId, input)),
    );
  }

  if (caller.scopes.has("todos:write")) {
    server.registerTool(
      "add_todo",
      {
        title: "Add a todo",
        description: "Adds a todo to the workspace.",
        inputSchema: createTodoInput,
      },
      ({ title }) => run(() => deps.todos.create(orgId, userId, title)),
    );
    server.registerTool(
      "set_todo_completed",
      {
        title: "Complete or reopen a todo",
        description:
          "Marks a todo done or not done. Pass the `version` from list_todos; if someone changed it since, list again and retry.",
        inputSchema: setTodoCompletedInput,
        annotations: { idempotentHint: true },
      },
      (input) => run(() => deps.todos.setCompleted(orgId, input)),
    );
    server.registerTool(
      "delete_todo",
      {
        title: "Delete a todo",
        description: "Deletes a todo from the workspace. This can't be undone.",
        inputSchema: deleteTodoInput,
        annotations: { destructiveHint: true },
      },
      ({ id }) => run(() => deps.todos.delete(orgId, id)),
    );
  }

  return server;
}
