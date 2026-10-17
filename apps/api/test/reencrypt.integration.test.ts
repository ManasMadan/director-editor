/**
 * Retiring a key: values written under the old keys are moved to the newest, after
 * which the old keys can go and everything still decrypts.
 */
import { createDatabase, type Database } from "@repo/db";
import { createTestDatabase, factories, type TestDatabase } from "@repo/db/testing";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authEncryptionKey } from "../src/auth/secrets";
import { reencryptSecrets } from "../src/secrets/reencrypt";

const OLD_AUTH = "o".repeat(40);
const NEW_AUTH = "n".repeat(40);
const BACKUP_CODES = JSON.stringify(["aaaaa-11111", "bbbbb-22222"]);

let testDb: TestDatabase;
let database: Database;
const ids = { account: "", twoFactor: "" };

beforeAll(async () => {
  testDb = await createTestDatabase();
  database = createDatabase({ url: testDb.urlFor("app_api"), poolMax: 2, service: "test" });
  const db = database.write;
  const { user } = await factories(db).userWithWorkspace();
  // Written before rotation: better-auth with its single secret.
  const legacy = (data: string) => symmetricEncrypt({ key: OLD_AUTH, data });
  ids.account = (
    await db.account.create({
      data: {
        userId: user.id,
        providerId: "google",
        accountId: user.id,
        accessToken: await legacy("access"),
        refreshToken: await legacy("refresh"),
      },
    })
  ).id;
  ids.twoFactor = (
    await db.twoFactor.create({
      data: { userId: user.id, secret: await legacy("totp-secret"), backupCodes: BACKUP_CODES },
    })
  ).id;
});

afterAll(async () => {
  await database?.disconnect();
  await testDb?.drop();
});

describe("re-encrypting secrets", () => {
  const rotated = () => ({
    authKey: authEncryptionKey(OLD_AUTH, [{ version: 1, value: NEW_AUTH }]),
  });

  it("moves every value to the newest key, and a second run changes nothing", async () => {
    expect(await reencryptSecrets(database, rotated())).toEqual({
      accounts: 1,
      twoFactors: 1,
    });
    expect(await reencryptSecrets(database, rotated())).toEqual({
      accounts: 0,
      twoFactors: 0,
    });
  });

  it("leaves nothing the old keys are needed for", async () => {
    const db = database.write;
    // The newest key alone: no legacy secret.
    const onlyNew = { keys: new Map([[1, NEW_AUTH]]), currentVersion: 1 };
    const open = (data: string) => symmetricDecrypt({ key: onlyNew, data });

    const account = await db.account.findUniqueOrThrow({ where: { id: ids.account } });
    expect(await open(account.accessToken ?? "")).toBe("access");
    expect(await open(account.refreshToken ?? "")).toBe("refresh");

    const twoFactor = await db.twoFactor.findUniqueOrThrow({ where: { id: ids.twoFactor } });
    expect(await open(twoFactor.secret)).toBe("totp-secret");
    // Backup codes stored in the clear before are now encrypted too.
    expect(twoFactor.backupCodes.startsWith("$ba$1$")).toBe(true);
    expect(await open(twoFactor.backupCodes)).toBe(BACKUP_CODES);
  });

  it("leaves better-auth's values alone while it has a single secret", async () => {
    const result = await reencryptSecrets(database, {
      authKey: authEncryptionKey(NEW_AUTH, undefined),
    });
    expect(result).toMatchObject({ accounts: 0, twoFactors: 0 });
  });

  it("goes through tables bigger than one page", async () => {
    const db = database.write;
    const { user } = await factories(db).userWithWorkspace();
    const legacy = await symmetricEncrypt({ key: OLD_AUTH, data: "access" });
    await db.account.createMany({
      data: Array.from({ length: 450 }, (_, i) => ({
        userId: user.id,
        providerId: "google",
        accountId: `${user.id}-${i}`,
        accessToken: legacy,
      })),
    });
    expect(await reencryptSecrets(database, rotated())).toMatchObject({ accounts: 450 });
  });
});
