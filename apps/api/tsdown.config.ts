import { nodeService } from "@repo/tsdown-config";

// The service, plus the commands that run its modules: the demo seed, the load-test users
// and the secrets re-encryption.
export default nodeService({
  entry: [
    "src/main.ts",
    "src/telemetry.ts",
    "src/seed.ts",
    "src/load-users.ts",
    "src/reencrypt.ts",
  ],
});
