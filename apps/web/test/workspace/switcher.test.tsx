import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { WorkspaceSwitcher } from "@/modules/workspace";
import { renderPage, router } from "../render";
import { signUp } from "../users";
import { teamWorkspace } from "./support";

const render = () => renderPage(<WorkspaceSwitcher />, { url: "/dashboard" });
const trigger = (page: Awaited<ReturnType<typeof render>>) =>
  page.getByRole("button", { name: "Workspace" });

describe("the workspace switcher", () => {
  it("names the active workspace, and switches to another", async () => {
    await signUp();
    const team = await teamWorkspace("Acme");
    const page = await render();
    await expect.element(trigger(page)).toHaveTextContent("Acme");
    await userEvent.click(trigger(page));
    // Choosing the one you're in does nothing.
    await userEvent.click(page.getByRole("menuitemradio", { name: "Acme" }));
    expect(router.refreshes).toBe(0);
    await userEvent.click(page.getByRole("menuitemradio", { name: "Personal" }));
    await expect.element(trigger(page)).toHaveTextContent("Personal");
    expect(router.refreshes).toBe(1);

    // Deleted meanwhile: switching to it fails, and says so.
    await commands.sql("DELETE FROM auth.organization WHERE id = $1", [team.id]);
    await userEvent.click(page.getByRole("menuitemradio", { name: "Acme" }));
    await expect.element(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  });

  it("creates a workspace and moves into it", async () => {
    await signUp();
    const page = await render();
    await userEvent.click(trigger(page));
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace" }));
    const dialog = page.getByRole("dialog");
    await userEvent.click(dialog.getByRole("button", { name: "Create workspace" }));
    await expect.element(dialog.getByText("Required")).toBeVisible();
    await userEvent.fill(dialog.getByLabelText("Workspace name"), "  Ünïcode Crew!  ");
    await userEvent.click(dialog.getByRole("button", { name: "Create workspace" }));
    await expect.element(page.getByText("Workspace created")).toBeVisible();
    await expect.element(trigger(page)).toHaveTextContent("Ünïcode Crew!");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    // A name with no letters for its address still gets one.
    await userEvent.click(trigger(page));
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace" }));
    await userEvent.fill(page.getByLabelText("Workspace name"), "✨✨✨");
    await userEvent.click(page.getByRole("button", { name: "Create workspace" }));
    await expect.element(trigger(page)).toHaveTextContent("✨✨✨");
    const [created] = await commands.sql<{ slug: string }>(
      "SELECT slug FROM auth.organization WHERE name = '✨✨✨' ORDER BY created_at DESC LIMIT 1",
    );
    expect(created?.slug).toMatch(/^workspace-[0-9a-f]{6}$/);
  });

  it("shows a workspace's name even when its settings are unreadable", async () => {
    await signUp();
    const team = await teamWorkspace("Odd");
    await commands.sql("UPDATE auth.organization SET metadata = 'not json' WHERE id = $1", [
      team.id,
    ]);
    const page = await render();
    await expect.element(trigger(page)).toHaveTextContent("Odd");
  });

  it("says when no more workspaces can be created", async () => {
    const me = await signUp();
    // Everyone may belong to 20 workspaces; this user has their personal one.
    await commands.sql(
      `WITH orgs AS (
         INSERT INTO auth.organization (name, slug)
         SELECT 'Filler ' || n, 'filler-' || gen_random_uuid() FROM generate_series(1, 19) n
         RETURNING id)
       INSERT INTO auth.member (organization_id, user_id, role) SELECT id, $1, 'owner' FROM orgs`,
      [me.id],
    );
    const page = await render();
    await userEvent.click(trigger(page));
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace" }));
    await userEvent.fill(page.getByLabelText("Workspace name"), "One too many");
    await userEvent.click(page.getByRole("button", { name: "Create workspace" }));
    await expect.element(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  });
});
