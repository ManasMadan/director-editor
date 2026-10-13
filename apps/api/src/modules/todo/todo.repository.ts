/**
 * Data access for todos. The only place that knows how todos are stored. Every query
 * runs through withTenant/tenantTx, so row-level security scopes it to the caller's
 * organization even if a where clause is forgotten.
 */
import { Injectable } from "@nestjs/common";
import type { OrgId, TodoId, UserId } from "@repo/contracts/ids";
import type { PageInput } from "@repo/contracts/pagination";
import { type Tx, withTenant } from "@repo/db";
import { type Database, InjectDatabase } from "@repo/nest-common";

const columns = { id: true, title: true, completed: true, version: true, createdAt: true } as const;

@Injectable()
export class TodoRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  /** Newest first, `limit + 1` rows so the caller can tell whether another page exists. */
  list(orgId: OrgId, { limit, cursor }: PageInput) {
    return withTenant(this.database.read, orgId).todo.findMany({
      where: cursor ? { id: { lt: cursor } } : {},
      orderBy: { id: "desc" },
      take: limit + 1,
      select: columns,
    });
  }

  create(tx: Tx, data: { orgId: OrgId; createdById: UserId; title: string }) {
    return tx.todo.create({ data, select: columns });
  }

  /** Updates only if the row still has the version the caller read (optimistic concurrency). */
  async setCompleted(
    tx: Tx,
    { id, completed, version }: { id: TodoId; completed: boolean; version: number },
  ) {
    const { count } = await tx.todo.updateMany({
      where: { id, version },
      data: { completed, version: { increment: 1 } },
    });
    if (count === 0) {
      return null;
    }
    return tx.todo.findUniqueOrThrow({ where: { id }, select: columns });
  }

  exists(tx: Tx, id: TodoId) {
    return tx.todo.findUnique({ where: { id }, select: { id: true } }).then(Boolean);
  }

  async delete(tx: Tx, id: TodoId) {
    const { count } = await tx.todo.deleteMany({ where: { id } });
    return count > 0;
  }
}
