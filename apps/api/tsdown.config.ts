import { nodeService } from "@repo/tsdown-config";

// The service, plus the commands that run its modules: the demo seed, the signed-in users
// the fuzzing runs as, the secrets re-encryption, Director's seed backfill and Director's
// shared demo account.
export default nodeService({
  entry: [
    "src/main.ts",
    "src/telemetry.ts",
    "src/seed.ts",
    "src/load-users.ts",
    "src/reencrypt.ts",
    "src/director-seed-workspaces.ts",
    "src/director-demo-account.ts",
  ],
});
