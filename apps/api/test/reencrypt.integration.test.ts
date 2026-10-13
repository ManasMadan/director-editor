/**
 * Retiring a key: values written under the old keys are moved to the newest, after
 * which the old keys can go and everything still decrypts.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { OrgId } from "@repo/contracts/ids";
import { createDatabase, type Database, tenantTx } from "@repo/db";
import { createTestDatabase, factories, type TestDatabase } from "@repo/db/testing";
import { keysFromEnv, SecretBox, webhookSecretContext } from "@repo/nest-common";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authEncryptionKey } from "../src/auth/secrets";
import { reencryptSecrets } from "../src/secrets/reencrypt";

const OLD_AUTH = "o".repeat(40);
const NEW_AUTH = "n".repeat(40);
const oldKey = `old:${randomBytes(32).toString("base64")}`;
const newKey = `new:${randomBytes(32).toString("base64")}`;
const BACKUP_CODES = JSON.stringify(["aaaaa-11111", "bbbbb-22222"]);

let testDb: TestDatabase;
let database: Database;
const ids = { account: "", twoFactor: "", jwks: "", endpoint: "" };
let orgId: OrgId;

beforeAll(async () => {
  testDb = await createTestDatabase();
  database = createDatabase({ url: testDb.urlFor("app_api"), poolMax: 2, service: "test" });
  const db = database.write;
  const { user, org } = await factories(db).userWithWorkspace();
  orgId = org.id;
  // Written before rotation: better-auth with its single secret, and the old data key.
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
  ids.jwks = (
    await db.jwks.create({
      data: { publicKey: "{}", privateKey: JSON.stringify(await legacy('{"d":"private"}')) },
    })
  ).id;
  const oldBox = new SecretBox(keysFromEnv(oldKey));
  ids.endpoint = randomUUID();
  const context = webhookSecretContext(ids.endpoint);
  await tenantTx(db, org.id, (tx) =>
    tx.webhookEndpoint.create({
      data: {
        id: ids.endpoint,
        orgId: org.id,
        url: "https://example.com/hook",
        events: [],
        secret: oldBox.encrypt("whsec_x", context),
        // Rotated recently: the one it replaced still signs.
        previousSecret: oldBox.encrypt("whsec_before", context),
        previousSecretExpiresAt: new Date(Date.now() + 3_600_000),
      },
    }),
  );
});

afterAll(async () => {
  await database?.disconnect();
  await testDb?.drop();
});

describe("re-encrypting secrets", () => {
  const rotated = () => ({
    authKey: authEncryptionKey(OLD_AUTH, [{ version: 1, value: NEW_AUTH }]),
    box: new SecretBox(keysFromEnv(`${newKey},${oldKey}`)),
  });

  it("moves every value to the newest key, and a second run changes nothing", async () => {
    expect(await reencryptSecrets(database, rotated())).toEqual({
      accounts: 1,
      twoFactors: 1,
      signingKeys: 1,
      webhookEndpoints: 1,
    });
    expect(await reencryptSecrets(database, rotated())).toEqual({
      accounts: 0,
      twoFactors: 0,
      signingKeys: 0,
      webhookEndpoints: 0,
    });
  });

  it("leaves nothing the old keys are needed for", async () => {
    const db = database.write;
    // The newest keys alone: no legacy secret, no old data key.
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

    const jwks = await db.jwks.findUniqueOrThrow({ where: { id: ids.jwks } });
    expect(await open(JSON.parse(jwks.privateKey) as string)).toBe('{"d":"private"}');

    const endpoint = await tenantTx(db, orgId, (tx) =>
      tx.webhookEndpoint.findUniqueOrThrow({ where: { id: ids.endpoint } }),
    );
    const newBox = new SecretBox(keysFromEnv(newKey));
    const context = webhookSecretContext(ids.endpoint);
    expect(newBox.decrypt(endpoint.secret, context)).toBe("whsec_x");
    expect(newBox.decrypt(endpoint.previousSecret ?? "", context)).toBe("whsec_before");
  });

  it("leaves better-auth's values alone while it has a single secret", async () => {
    const result = await reencryptSecrets(database, {
      authKey: authEncryptionKey(NEW_AUTH, undefined),
      box: new SecretBox(keysFromEnv(newKey)),
    });
    expect(result).toMatchObject({ accounts: 0, twoFactors: 0, signingKeys: 0 });
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
