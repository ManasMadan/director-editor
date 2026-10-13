/**
 * Moves every encrypted value to the newest key, so older keys can be retired:
 * better-auth's values (OAuth tokens, 2FA secrets and backup codes, JWT signing keys) to
 * the newest BETTER_AUTH_SECRETS version, and webhook endpoint secrets (the current and
 * the previous one) to the active ENCRYPTION_KEYS key and SecretBox's current format. Run by `bun run --filter @repo/api secrets:reencrypt` (src/reencrypt.ts).
 *
 * Safe while the services run and safe to repeat: each row is written only if it still
 * holds the value that was read (a token refreshed meanwhile is left alone and is
 * already on the newest key), and values already on the newest key are skipped.
 */
import { type OrgId, orgIdSchema } from "@repo/contracts/ids";
import { type Database, tenantTx } from "@repo/db";
import { type SecretBox, webhookSecretContext } from "@repo/nest-common";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import * as z from "zod";
import type { authEncryptionKey } from "../auth/secrets";

type AuthKey = ReturnType<typeof authEncryptionKey>;

export interface ReencryptResult {
  accounts: number;
  twoFactors: number;
  signingKeys: number;
  webhookEndpoints: number;
}

const PAGE = 200;

type Db = Database["write"];

/** Moves better-auth's encrypted values to `authKey`'s current version, row by row. */
class AuthValues {
  private readonly current: string;

  constructor(
    private readonly db: Db,
    private readonly authKey: Exclude<AuthKey, string>,
  ) {
    this.current = `$ba$${authKey.currentVersion}$`;
  }

  private onCurrent(value: string) {
    return value.startsWith(this.current);
  }

  private async refresh(value: string) {
    if (this.onCurrent(value)) {
      return value;
    }
    const data = await symmetricDecrypt({ key: this.authKey, data: value });
    return symmetricEncrypt({ key: this.authKey, data });
  }

  /** OAuth tokens on linked accounts. */
  async accounts() {
    let updated = 0;
    for await (const account of pages((cursor) =>
      this.db.account.findMany({
        select: { id: true, accessToken: true, refreshToken: true, idToken: true },
        ...cursor,
      }),
    )) {
      const data: Record<string, string> = {};
      for (const field of ["accessToken", "refreshToken", "idToken"] as const) {
        const value = account[field];
        if (value && !this.onCurrent(value)) {
          data[field] = await this.refresh(value);
        }
      }
      if (Object.keys(data).length === 0) {
        continue;
      }
      const { count } = await this.db.account.updateMany({
        where: {
          id: account.id,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          idToken: account.idToken,
        },
        data,
      });
      updated += count;
    }
    return updated;
  }

  /** Two-factor secrets and backup codes. */
  async twoFactors() {
    let updated = 0;
    for await (const row of pages((cursor) =>
      this.db.twoFactor.findMany({
        select: { id: true, secret: true, backupCodes: true },
        ...cursor,
      }),
    )) {
      // Backup codes written before they were encrypted are a plain JSON array.
      const backupCodes = row.backupCodes.startsWith("[")
        ? await symmetricEncrypt({ key: this.authKey, data: row.backupCodes })
        : await this.refresh(row.backupCodes);
      const secret = await this.refresh(row.secret);
      if (secret === row.secret && backupCodes === row.backupCodes) {
        continue;
      }
      const { count } = await this.db.twoFactor.updateMany({
        where: { id: row.id, secret: row.secret, backupCodes: row.backupCodes },
        data: { secret, backupCodes },
      });
      updated += count;
    }
    return updated;
  }

  /** JWT signing keys, which store the encrypted private key as a JSON string. */
  async signingKeys() {
    let updated = 0;
    for await (const key of pages((cursor) =>
      this.db.jwks.findMany({ select: { id: true, privateKey: true }, ...cursor }),
    )) {
      const encrypted = z.string().parse(JSON.parse(key.privateKey));
      if (this.onCurrent(encrypted)) {
        continue;
      }
      const { count } = await this.db.jwks.updateMany({
        where: { id: key.id, privateKey: key.privateKey },
        data: { privateKey: JSON.stringify(await this.refresh(encrypted)) },
      });
      updated += count;
    }
    return updated;
  }
}

/** One workspace's webhook endpoint secrets, the current and the previous one, on `box`'s key. */
async function reencryptWebhookEndpoints(db: Db, orgId: OrgId, box: SecretBox) {
  // Webhook endpoints are tenant rows: each workspace's inside its own tenant context.
  return tenantTx(db, orgId, async (tx) => {
    let count = 0;
    const endpoints = await tx.webhookEndpoint.findMany({
      select: { id: true, secret: true, previousSecret: true },
    });
    for (const { id, secret, previousSecret } of endpoints) {
      // The previous secret too: it still signs until its overlap ends, and would fail
      // to decrypt once its key is dropped.
      const context = webhookSecretContext(id);
      const refresh = (value: string) =>
        box.needsRotation(value) ? box.encrypt(box.decrypt(value, context), context) : value;
      const data = {
        secret: refresh(secret),
        previousSecret: previousSecret && refresh(previousSecret),
      };
      if (data.secret === secret && data.previousSecret === previousSecret) {
        continue;
      }
      const updated = await tx.webhookEndpoint.updateMany({
        where: { id, secret, previousSecret },
        data,
      });
      count += updated.count;
    }
    return count;
  });
}

export async function reencryptSecrets(
  database: Database,
  { authKey, box }: { authKey: AuthKey; box: SecretBox },
): Promise<ReencryptResult> {
  const db = database.write;
  const result: ReencryptResult = {
    accounts: 0,
    twoFactors: 0,
    signingKeys: 0,
    webhookEndpoints: 0,
  };

  // Without versioned secrets there is one key, so better-auth's values are current.
  if (typeof authKey !== "string") {
    const values = new AuthValues(db, authKey);
    result.accounts = await values.accounts();
    result.twoFactors = await values.twoFactors();
    result.signingKeys = await values.signingKeys();
  }

  for await (const org of pages((cursor) =>
    db.organization.findMany({ select: { id: true }, ...cursor }),
  )) {
    result.webhookEndpoints += await reencryptWebhookEndpoints(db, orgIdSchema.parse(org.id), box);
  }
  return result;
}

/** Every row of a table, a page at a time in id order. */
async function* pages<T extends { id: string }>(
  fetch: (cursor: {
    take: number;
    orderBy: { id: "asc" };
    cursor?: { id: string };
    skip?: number;
  }) => Promise<T[]>,
) {
  let after: string | undefined;
  for (;;) {
    const rows = await fetch({
      take: PAGE,
      orderBy: { id: "asc" },
      ...(after && { cursor: { id: after }, skip: 1 }),
    });
    yield* rows;
    if (rows.length < PAGE) {
      return;
    }
    after = rows.at(-1)?.id;
  }
}
