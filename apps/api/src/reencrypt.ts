/**
 * Re-encrypts every stored secret with the newest keys, so older ones can be retired:
 * `bun run secrets:reencrypt` locally; in a cluster, the api image with the command
 * `node dist/reencrypt.mjs`. What it touches and why it's safe to run live:
 * src/secrets/reencrypt.ts. How to rotate each key: the rotate-secrets skill.
 */
import { createDatabase } from "@repo/db";
import { authEncryptionKey } from "./auth/secrets";
import { env } from "./env";
import { reencryptSecrets } from "./secrets/reencrypt";

const database = createDatabase({ url: env.API_DATABASE_URL, poolMax: 2, service: "reencrypt" });
try {
  const result = await reencryptSecrets(database, {
    authKey: authEncryptionKey(env.BETTER_AUTH_SECRET, env.BETTER_AUTH_SECRETS),
  });
  console.log(
    `Re-encrypted ${result.accounts} accounts and ${result.twoFactors} two-factor settings.`,
  );
  if (!env.BETTER_AUTH_SECRETS) {
    console.log(
      "BETTER_AUTH_SECRETS isn't set, so better-auth's values have one key and were left as they are.",
    );
  }
} finally {
  await database.disconnect();
}
