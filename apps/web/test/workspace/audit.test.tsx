import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { WorkspaceAuditPage } from "@/modules/workspace";
import { renderPage } from "../render";
import { signUp } from "../users";
import { setRole, teamWorkspace } from "./support";

const render = () => renderPage(<WorkspaceAuditPage />, { url: "/settings/audit" });

/** What the audit consumer records for events in the workspace. */
async function record(
  orgId: string,
  entries: { name: string; payload: object; actorId?: string | null; minutesAgo?: number }[],
) {
  // What the worker's maintenance does: the log is partitioned by month.
  await commands.sql("SELECT audit.ensure_partitions(1, 1)");
  for (const entry of entries) {
    await commands.sql(
      `INSERT INTO audit.audit_log (id, occurred_at, name, key, payload, org_id, actor_id, source)
       VALUES (uuidv7(), now() - make_interval(mins => $1), $2, 'k', $3, $4, $5, 'api')`,
      [
        entry.minutesAgo ?? 0,
        entry.name,
        JSON.stringify(entry.payload),
        orgId,
        entry.actorId ?? null,
      ],
    );
  }
}

describe("the audit log", () => {
  it("says what happened, who did it and when, in the user's words", async () => {
    const me = await signUp();
    const workspace = await teamWorkspace();
    const page = await render();
    await expect.element(page.getByText("Nothing has happened here yet.")).toBeVisible();

    await record(workspace.id, [
      { name: "todo.created.v1", payload: { title: "Ship it" }, actorId: me.id, minutesAgo: 3 },
      {
        name: "auth.two_factor_changed.v1",
        payload: { enabled: true },
        actorId: me.id,
        minutesAgo: 2,
      },
      {
        name: "org.invitation_sent.v1",
        payload: { email: ["a@x.dev", "b@x.dev"], role: "admin", count: 2 },
        minutesAgo: 1,
      },
      { name: "custom.thing.v1", payload: {} },
    ]);
    const log = await render();
    await expect.element(log.getByText("Created the todo “Ship it”")).toBeVisible();
    await expect.element(log.getByText("Turned on two-step verification")).toBeVisible();
    await expect.element(log.getByText("Invited a@x.dev, b@x.dev as admin")).toBeVisible();
    await expect.element(log.getByText("custom.thing.v1")).toBeVisible();
    await expect.element(log.getByText("System").first()).toBeVisible();
    await expect.element(log.getByText(me.name).first()).toBeVisible();
  });

  it("loads older entries on request", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    await record(
      workspace.id,
      Array.from({ length: 51 }, (_, index) => ({
        name: "todo.created.v1",
        payload: { title: `Todo ${index}` },
      })),
    );
    const page = await render();
    // Newest first, fifty at a time.
    await expect.element(page.getByText("Created the todo “Todo 50”")).toBeVisible();
    expect(page.getByText("Created the todo “Todo 0”").query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Load more" }));
    await expect.element(page.getByText("Created the todo “Todo 0”")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("is for owners and admins", async () => {
    const me = await signUp();
    const workspace = await teamWorkspace();
    await setRole(workspace.id, me.id, "member");
    const page = await render();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("You don't have permission to do that.");
  });
});
