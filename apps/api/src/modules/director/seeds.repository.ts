/**
 * Director's seeded templates in each workspace's library: the 6 committed in
 * @repo/contracts/director-seeds, copied into a workspace in the transaction that creates
 * it (src/auth: sign-up's personal workspace and every team one), and into workspaces made
 * before that by `bun run --filter @repo/api director:seed-workspaces`
 * (src/director-seed-workspaces.ts).
 *
 * The AI service owns ai.director_plan; this API may insert seeds into it and nothing
 * more (migration 20261018170000_director_seed_copies): no reads, no updates, no plan in
 * anyone's name. A plan's audio link is made from its audio key when the library is read
 * (DirectorService), through the storage seam, so a copy holds only the key.
 */
import { directorSeeds } from "@repo/contracts/director-seeds";
import { type OrgId, orgIdSchema } from "@repo/contracts/ids";
import { type Database, enterTenant, type Tx, tenantTx } from "@repo/db";

// The library lists plans newest first (by their uuidv7 ids, which follow the insertion
// order), so the seeds go in last to first and the seed list's first one shows first.
const NEWEST_LAST = directorSeeds.toReversed();

/**
 * Copies the seeds into the workspace, inside the caller's transaction: ready to film, in
 * nobody's name, so a copy never counts as anyone's one index. A Short the workspace
 * already has a plan of (an earlier copy, or a member's own index of the same Short) keeps
 * that plan; (org_id, video_id) is unique. Returns how many it added.
 */
export async function copySeedTemplates(tx: Tx, orgId: OrgId): Promise<number> {
  await enterTenant(tx, orgId);
  const { count } = await tx.directorPlan.createMany({
    data: NEWEST_LAST.map((seed) => ({
      orgId,
      videoId: seed.videoId,
      source: "seed",
      status: "ready",
      stage: "ready",
      plan: seed.plan,
      model: seed.model,
      audioStatus: "ready",
      audioKey: seed.audioKey,
    })),
    skipDuplicates: true,
  });
  return count;
}

export interface SeedBackfill {
  /** Workspaces looked at: all of them. */
  workspaces: number;
  /** Those that were missing at least one seed. */
  seeded: number;
  /** Seed plans added, across them. */
  templates: number;
}

// Workspaces read per query; each one's copy is a transaction of its own, so a failure
// halfway leaves every workspace before it done and a second run picks up the rest.
const WORKSPACE_PAGE = 200;

/**
 * Gives every workspace whatever seeds it's missing, and says how many it touched. Safe to
 * run any number of times, on a live database: it only ever adds seed rows a workspace
 * doesn't have, and never changes or removes a plan.
 */
export async function seedWorkspaces(
  database: Database,
  pageSize = WORKSPACE_PAGE,
): Promise<SeedBackfill> {
  const result: SeedBackfill = { workspaces: 0, seeded: 0, templates: 0 };
  let after: OrgId | undefined;
  for (;;) {
    const page = await database.read.organization.findMany({
      select: { id: true },
      ...(after && { where: { id: { gt: after } } }),
      orderBy: { id: "asc" },
      take: pageSize,
    });
    for (const { id } of page) {
      const orgId = orgIdSchema.parse(id);
      const added = await tenantTx(database.write, orgId, (tx) => copySeedTemplates(tx, orgId));
      result.workspaces += 1;
      result.seeded += added > 0 ? 1 : 0;
      result.templates += added;
      after = orgId;
    }
    if (page.length < pageSize) {
      return result;
    }
  }
}
