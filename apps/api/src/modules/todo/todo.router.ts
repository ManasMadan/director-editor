/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { TodoService } from "./todo.service";

export const todoRouter = ({ inOrg }: Procedures, todos: TodoService) => ({
  list: inOrg.todo.list.handler(({ context, input }) => todos.list(context.orgId, input)),
  create: inOrg.todo.create.handler(({ context, input }) =>
    todos.create(context.orgId, context.userId, input.title),
  ),
  setCompleted: inOrg.todo.setCompleted.handler(({ context, input }) =>
    todos.setCompleted(context.orgId, input),
  ),
  delete: inOrg.todo.delete.handler(({ context, input }) => todos.delete(context.orgId, input.id)),
});
