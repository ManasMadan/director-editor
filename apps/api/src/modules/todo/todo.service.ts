/**
 * Todo business rules. Each change and its domain event are written in one tenant
 * transaction, so the audit log, webhooks and notifications never miss or invent one.
 */
import { Injectable } from "@nestjs/common";
import { API_KEY_REQUESTS_PER_MINUTE } from "@repo/contracts/api";
import { type OrgId, type TodoId, todoIdSchema, type UserId } from "@repo/contracts/ids";
import { type PageInput, toPage } from "@repo/contracts/pagination";
import { tenantTx } from "@repo/db";
import {
  AppError,
  createRateLimiter,
  type Database,
  InjectDatabase,
  InjectRedis,
  type RateLimiter,
  type Redis,
} from "@repo/nest-common";
import { emitEvent } from "../../outbox";
import { TodoRepository } from "./todo.repository";

@Injectable()
export class TodoService {
  // Every change goes out to the workspace's webhook endpoints, so a workspace's writes
  // are capped as a whole (one API key's allowance), however many keys it spreads them over.
  private readonly writes: RateLimiter;

  constructor(
    @InjectDatabase() private readonly database: Database,
    private readonly todos: TodoRepository,
    @InjectRedis() redis: Redis,
  ) {
    this.writes = createRateLimiter(redis, {
      name: "todo-writes",
      points: API_KEY_REQUESTS_PER_MINUTE,
      windowSeconds: 60,
      onRedisError: "allow",
    });
  }

  async list(orgId: OrgId, page: PageInput) {
    return toPage(await this.todos.list(orgId, page), page.limit);
  }

  async create(orgId: OrgId, userId: UserId, title: string) {
    await this.writes.take(orgId);
    return tenantTx(this.database.write, orgId, async (tx) => {
      const todo = await this.todos.create(tx, { orgId, createdById: userId, title });
      const todoId = todoIdSchema.parse(todo.id);
      await emitEvent(tx, "todo.created.v1", todoId, { todoId, title: todo.title });
      return { ...todo, id: todoId };
    });
  }

  async setCompleted(orgId: OrgId, input: { id: TodoId; completed: boolean; version: number }) {
    await this.writes.take(orgId);
    return tenantTx(this.database.write, orgId, async (tx) => {
      const todo = await this.todos.setCompleted(tx, input);
      if (!todo) {
        // Distinguish "someone else changed it first" from "it doesn't exist (for you)".
        const exists = await this.todos.exists(tx, input.id);
        throw new AppError(exists ? "TODO_VERSION_CONFLICT" : "TODO_NOT_FOUND", {
          params: { id: input.id },
        });
      }
      if (todo.completed) {
        await emitEvent(tx, "todo.completed.v1", input.id, { todoId: input.id, title: todo.title });
      }
      return todo;
    });
  }

  async delete(orgId: OrgId, id: TodoId) {
    await this.writes.take(orgId);
    return tenantTx(this.database.write, orgId, async (tx) => {
      if (!(await this.todos.delete(tx, id))) {
        throw new AppError("TODO_NOT_FOUND", { params: { id } });
      }
      await emitEvent(tx, "todo.deleted.v1", id, { todoId: id });
    });
  }
}
