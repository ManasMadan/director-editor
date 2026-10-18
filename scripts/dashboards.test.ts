/**
 * The Grafana dashboards over the activity logs (deploy/platform/dashboards/files): each
 * is valid JSON with a uid of its own, and asks only for activity names the services
 * write (@repo/contracts/activity), so renaming one there fails here until its queries
 * follow.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIVITIES } from "@repo/contracts/activity";
import * as z from "zod";
import { ROOT } from "./lib";

const DIR = join(ROOT, "deploy/platform/dashboards/files");
const files = readdirSync(DIR).filter((file) => file.endsWith(".json"));

const dashboard = z.object({
  uid: z.string().min(1),
  title: z.string().min(1),
  panels: z
    .array(z.object({ targets: z.array(z.object({ expr: z.string().min(1) })).min(1) }))
    .min(1),
});

/** Every activity name a query compares with (`activity="..."`). */
function activitiesAskedFor(expr: string) {
  return [...expr.matchAll(/activity="([^"]+)"/g)].flatMap((match) => match.slice(1));
}

describe("the activity dashboards", () => {
  it("are People, Who did what and Director, each with its own uid", () => {
    const uids = files.map(
      (file) => dashboard.parse(JSON.parse(readFileSync(join(DIR, file), "utf8"))).uid,
    );
    expect(files.sort()).toEqual(["director.json", "people.json", "who-did-what.json"]);
    expect(new Set(uids).size).toBe(files.length);
  });

  it.each(files)("%s asks only for activities the services write", (file) => {
    const { panels } = dashboard.parse(JSON.parse(readFileSync(join(DIR, file), "utf8")));
    const exprs = panels.flatMap((panel) => panel.targets.map((target) => target.expr));
    for (const expr of exprs) {
      // Every query reads one namespace's lines, as JSON.
      expect(expr).toContain('{namespace="$namespace"}');
    }
    const asked = exprs.flatMap(activitiesAskedFor);
    for (const name of asked) {
      expect(ACTIVITIES as readonly string[]).toContain(name);
    }
  });
});
