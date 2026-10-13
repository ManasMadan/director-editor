/**
 * Rotating better-auth's secret. BETTER_AUTH_SECRET alone signs session cookies and
 * encrypts what better-auth stores (OAuth tokens, 2FA secrets and backup codes, the JWT
 * signing keys). To rotate it, add versioned secrets, newest first:
 *
 *   BETTER_AUTH_SECRETS="2:<new secret>,1:<previous secret>"
 *
 * The first one signs and encrypts from then on; every listed one still decrypts, and
 * BETTER_AUTH_SECRET stays as the key for values written before versions existed. Then
 * `bun run --filter @repo/api secrets:reencrypt` moves every stored value to the newest
 * version, after which older versions (and eventually BETTER_AUTH_SECRET's value) can
 * go. Session cookies are signed with the newest secret only, so a rotation signs
 * everyone out once.
 */
export interface AuthSecret {
  version: number;
  value: string;
}

/** Parses `version:secret,version:secret` (newest first); throws with a readable reason. */
export function parseAuthSecrets(value: string): AuthSecret[] {
  const secrets = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colon = entry.indexOf(":");
      const version = Number(entry.slice(0, colon));
      const secret = entry.slice(colon + 1).trim();
      if (colon === -1 || !Number.isInteger(version) || version < 0) {
        throw new Error("BETTER_AUTH_SECRETS entries look like `<version>:<secret>`");
      }
      if (secret.length < 32) {
        throw new Error(`BETTER_AUTH_SECRETS version ${version} must be at least 32 characters`);
      }
      return { version, value: secret };
    });
  if (secrets.length === 0) {
    throw new Error("BETTER_AUTH_SECRETS lists no secrets");
  }
  if (new Set(secrets.map((secret) => secret.version)).size !== secrets.length) {
    throw new Error("BETTER_AUTH_SECRETS lists a version twice");
  }
  return secrets;
}

/**
 * The key better-auth's `symmetricEncrypt`/`symmetricDecrypt` take: the single secret,
 * or the versioned secrets with the single one kept for values written before them.
 */
export function authEncryptionKey(secret: string, secrets: AuthSecret[] | undefined) {
  const [current] = secrets ?? [];
  if (!secrets || !current) {
    return secret;
  }
  return {
    keys: new Map(secrets.map(({ version, value }) => [version, value])),
    currentVersion: current.version,
    legacySecret: secret,
  };
}
