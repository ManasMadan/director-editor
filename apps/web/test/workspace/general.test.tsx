import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { WorkspaceGeneralPage } from "@/modules/workspace";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import { addMember, setRole, teamWorkspace } from "./support";

const render = () => renderPage(<WorkspaceGeneralPage />, { url: "/settings/workspace" });

describe("workspace settings", () => {
  it("a personal workspace can be renamed, but not deleted", async () => {
    await signUp();
    const page = await render();
    await expect
      .element(page.getByText("This is your personal workspace. It can't be shared or deleted."))
      .toBeVisible();
    expect(page.getByText("Delete workspace").query()).toBeNull();
  });

  it("renames a team workspace, and says when that's no longer allowed", async () => {
    const me = await signUp();
    const workspace = await teamWorkspace("Acme");
    const page = await render();
    await expect.element(page.getByText("Settings for everyone in Acme.")).toBeVisible();
    const save = page.getByRole("button", { name: "Save" });
    await expect.element(save).toBeDisabled();
    await userEvent.fill(page.getByLabelText("Name"), "Acme Labs");
    await userEvent.click(save);
    await expect.element(page.getByText("Workspace saved")).toBeVisible();
    await expect.element(page.getByText("Settings for everyone in Acme Labs.")).toBeVisible();

    await setRole(workspace.id, me.id, "member");
    await userEvent.fill(page.getByLabelText("Name"), "Taken over");
    await userEvent.click(save);
    await expect.element(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  });

  it("shows nothing for a workspace that was deleted meanwhile", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    await commands.sql("DELETE FROM auth.organization WHERE id = $1", [workspace.id]);
    const page = await render();
    await expect
      .poll(() => fetch("/api/auth/organization/get-full-organization").then((r) => r.status))
      .toBe(400);
    expect(page.getByLabelText("Name").query()).toBeNull();
  });

  it("only lets members read it", async () => {
    const me = await signUp();
    const workspace = await teamWorkspace();
    await addMember(workspace.id, "owner");
    await setRole(workspace.id, me.id, "member");
    const page = await render();
    await expect.element(page.getByLabelText("Name")).toBeDisabled();
    expect(page.getByRole("button", { name: "Save" }).query()).toBeNull();
    expect(page.getByText("Delete workspace").query()).toBeNull();
  });

  it("says when deleting fails, even with nowhere else to go", async () => {
    const me = await signUp();
    const workspace = await teamWorkspace("Kept");
    await commands.sql("DELETE FROM auth.organization WHERE slug = $1", [`personal-${me.id}`]);
    const page = await render();
    await userEvent.fill(page.getByLabelText("Type the workspace name to confirm"), "Kept");
    await setRole(workspace.id, me.id, "admin");
    await userEvent.click(page.getByRole("button", { name: "Delete workspace" }));
    await expect.element(page.getByText("Something went wrong. Please try again.")).toBeVisible();
    expect(currentUrl()).toBe("/settings/workspace");
  });
  it("deletes a team workspace once its name is typed, moving to another first", async () => {
    await signUp();
    await teamWorkspace("Doomed");
    const page = await render();
    const remove = page.getByRole("button", { name: "Delete workspace" });
    await expect.element(remove).toBeDisabled();
    await userEvent.fill(page.getByLabelText("Type the workspace name to confirm"), "Doomed");
    await userEvent.click(remove);
    await expect.element(page.getByText("Workspace deleted")).toBeVisible();
    await expect.poll(currentUrl).toBe("/dashboard");
  });
});
