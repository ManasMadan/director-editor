/**
 * Workspace API keys: creating, listing and revoking them (owners and admins, from the
 * settings page), and checking the key on a request (the request pipeline, see
 * rpc/procedures.ts).
 *
 * A key is stored as the api-key plugin's permissions (`{ todos: ["read", "write"] }`),
 * which are our scopes (`todos:read`) split at the colon, and remembers who created it
 * in its metadata. It acts as that person, with their current role, so it never has
 * more access than they do, and stops working when they leave the workspace.
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  API_KEY_LIMIT,
  API_KEY_SCOPES,
  type ApiKey,
  type ApiKeyScope,
  type createApiKeyInput,
  MAX_API_KEY_DAYS,
} from "@repo/contracts/api";
import {
  type ApiKeyId,
  apiKeyIdSchema,
  type OrgId,
  orgIdSchema,
  type UserId,
  userIdSchema,
} from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import type { OrgRole } from "@repo/contracts/roles";
import { DAY_S } from "@repo/contracts/time";
import { transaction } from "@repo/db";
import { AppError, type Database, InjectDatabase } from "@repo/nest-common";
import * as z from "zod";
import { AUTH, type Auth, MEMBERSHIPS, type Memberships } from "../../auth/auth.module";
import { emitEvent } from "../../outbox";
import { type ApiKeyRow, ApiKeysRepository } from "./api-keys.repository";

/** Who a verified key acts as, for the procedure it called. */
export interface ApiKeyCaller {
  apiKeyId: ApiKeyId;
  orgId: OrgId;
  userId: UserId;
  role: OrgRole;
  /** A key never counts as a fresh sign-in. */
  signedInAt: null;
}

const metadataSchema = z.object({ createdBy: userIdSchema });
const permissionsSchema = z.record(z.string(), z.array(z.string()));
const rateLimitDetails = z.object({ details: z.object({ tryAgainIn: z.number() }) });

function toPermissions(scopes: readonly ApiKeyScope[]) {
  const permissions: Record<string, string[]> = {};
  for (const scope of scopes) {
    const separator = scope.indexOf(":");
    const [resource, action] = [scope.slice(0, separator), scope.slice(separator + 1)];
    permissions[resource] = [...(permissions[resource] ?? []), action];
  }
  return permissions;
}

/** Scopes from stored permissions (text or parsed); anything unknown is dropped. */
function toScopes(permissions: unknown): ApiKeyScope[] {
  const parsed = permissionsSchema.safeParse(
    typeof permissions === "string" ? safeJson(permissions) : permissions,
  );
  if (!parsed.success) {
    return [];
  }
  const granted = new Set(
    Object.entries(parsed.data).flatMap(([resource, actions]) =>
      actions.map((action) => `${resource}:${action}`),
    ),
  );
  return API_KEY_SCOPES.filter((scope) => granted.has(scope));
}

function createdBy(metadata: unknown): UserId | null {
  const parsed = metadataSchema.safeParse(
    typeof metadata === "string" ? safeJson(metadata) : metadata,
  );
  return parsed.success ? parsed.data.createdBy : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

@Injectable()
export class ApiKeysService {
  constructor(
    @InjectDatabase() private readonly database: Database,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(MEMBERSHIPS) private readonly memberships: Memberships,
    private readonly keys: ApiKeysRepository,
  ) {}

  async list(orgId: OrgId): Promise<ApiKey[]> {
    const rows = await this.keys.list(orgId);
    return this.present(rows);
  }

  async create(orgId: OrgId, userId: UserId, input: z.infer<typeof createApiKeyInput>) {
    // A count, not a lock: two admins creating keys at the same moment can both pass it
    // and end a key or two over the limit, which is harmless for a cap this size. A hard
    // cap would need a lock on the organization's row for the duration of the create.
    if ((await this.keys.count(orgId)) >= API_KEY_LIMIT) {
      throw new AppError("API_KEY_LIMIT_REACHED", { params: { limit: API_KEY_LIMIT } });
    }
    // Server-side call: scopes (permissions) can only be set here, never by a client.
    const created = await this.auth.api.createApiKey({
      body: {
        organizationId: orgId,
        userId,
        name: input.name,
        // Every key expires: null (the contract's old "never") means the longest.
        expiresIn: (input.expiresInDays ?? MAX_API_KEY_DAYS) * DAY_S,
        permissions: toPermissions(input.scopes),
        metadata: { createdBy: userId },
      },
    });
    const apiKeyId = apiKeyIdSchema.parse(created.id);
    // The plugin commits the key itself, so the event is recorded just after, like
    // better-auth's other writes (see auth.ts).
    await transaction(this.database.write, (tx) =>
      emitEvent(
        tx,
        "org.api_key_created.v1",
        apiKeyId,
        { apiKeyId, name: input.name, scopes: [...input.scopes] },
        { actorId: userId, orgId },
      ),
    );
    const [apiKey] = await this.present([await this.keys.find(orgId, apiKeyId)]);
    return { apiKey: required(apiKey, "the new key"), key: created.key };
  }

  revoke(orgId: OrgId, userId: UserId, id: ApiKeyId) {
    return transaction(this.database.write, async (tx) => {
      const key = await this.keys.findForRevoke(tx, orgId, id);
      if (!key) {
        throw new AppError("API_KEY_NOT_FOUND");
      }
      await this.keys.remove(tx, key.id);
      await emitEvent(
        tx,
        "org.api_key_revoked.v1",
        id,
        { apiKeyId: id, name: key.name ?? "" },
        { actorId: userId, orgId },
      );
    });
  }

  /**
   * Checks the key for a procedure that needs `scope`: valid, not expired, within its
   * rate limit, granted that scope, and its creator still a member of its workspace.
   */
  async authenticate(key: string, scope: ApiKeyScope): Promise<ApiKeyCaller> {
    const result = await this.auth.api.verifyApiKey({ body: { key } });
    if (!result.valid || !result.key) {
      if (result.error?.code === "RATE_LIMITED") {
        // The plugin's rate limit always says when to try again.
        const retryAfterMs = rateLimitDetails.parse(result.error).details.tryAgainIn;
        throw new AppError("RATE_LIMITED", {
          params: { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) },
        });
      }
      throw new AppError("UNAUTHENTICATED");
    }
    const orgId = orgIdSchema.parse(result.key.referenceId);
    const userId = createdBy(result.key.metadata);
    const role = userId ? await this.memberships.role(orgId, userId) : null;
    if (!userId || !role) {
      throw new AppError("UNAUTHENTICATED");
    }
    if (!toScopes(result.key.permissions).includes(scope)) {
      throw new AppError("API_KEY_SCOPE_MISSING", { params: { scope } });
    }
    return { apiKeyId: apiKeyIdSchema.parse(result.key.id), orgId, userId, role, signedInAt: null };
  }

  private async present(rows: ApiKeyRow[]): Promise<ApiKey[]> {
    const creators = [...new Set(rows.flatMap((row) => createdBy(row.metadata) ?? []))];
    const users = new Map((await this.keys.users(creators)).map((user) => [user.id, user]));
    return rows.map((row) => {
      const creator = createdBy(row.metadata);
      const user = creator && users.get(creator);
      return {
        id: apiKeyIdSchema.parse(row.id),
        name: row.name ?? "",
        start: row.start ?? "",
        scopes: toScopes(row.permissions),
        createdBy: user ? { id: userIdSchema.parse(user.id), name: user.name } : null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        lastUsedAt: row.lastRequest,
      };
    });
  }
}
