/**
 * Moves every encrypted value to the newest key, so older keys can be retired:
 * better-auth's values (OAuth tokens, 2FA secrets and backup codes) to the newest
 * BETTER_AUTH_SECRETS version. Run by `bun run --filter @repo/api secrets:reencrypt`
 * (src/reencrypt.ts).
 *
 * Safe while the services run and safe to repeat: each row is written only if it still
 * holds the value that was read (a token refreshed meanwhile is left alone and is
 * already on the newest key), and values already on the newest key are skipped.
 */
import type { Database } from "@repo/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { authEncryptionKey } from "../auth/secrets";

type AuthKey = ReturnType<typeof authEncryptionKey>;

export interface ReencryptResult {
  accounts: number;
  twoFactors: number;
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
}

export async function reencryptSecrets(
  database: Database,
  { authKey }: { authKey: AuthKey },
): Promise<ReencryptResult> {
  const db = database.write;
  const result: ReencryptResult = {
    accounts: 0,
    twoFactors: 0,
  };

  // Without versioned secrets there is one key, so better-auth's values are current.
  if (typeof authKey !== "string") {
    const values = new AuthValues(db, authKey);
    result.accounts = await values.accounts();
    result.twoFactors = await values.twoFactors();
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
