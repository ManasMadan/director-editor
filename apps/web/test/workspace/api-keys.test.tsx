import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { WorkspaceApiKeysPage } from "@/modules/workspace";
import { cleanup, renderPage } from "../render";
import { signUp } from "../users";
import { setRole, teamWorkspace } from "./support";

const render = () => renderPage(<WorkspaceApiKeysPage />, { url: "/settings/api-keys" });

describe("API keys", () => {
  it("creates a key with the scopes asked for, shows it once, and revokes it", async () => {
    const me = await signUp();
    await commands.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await render();
    await expect.element(page.getByText("No API keys yet.")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "API reference" }))
      .toHaveAttribute("href", "/api/v1/openapi.json");

    await userEvent.fill(page.getByLabelText("Name"), "CI");
    await userEvent.click(page.getByRole("button", { name: "Create key" }));
    await expect.element(page.getByText("Choose at least one scope.")).toBeVisible();
    await userEvent.click(page.getByRole("checkbox", { name: /^todos:read/ }));
    await userEvent.click(page.getByRole("checkbox", { name: /^todos:write/ }));
    await userEvent.click(page.getByRole("checkbox", { name: /^todos:write/ }));
    await userEvent.click(page.getByRole("combobox", { name: "Expires" }));
    await userEvent.click(page.getByRole("option", { name: "In 30 days" }));
    await userEvent.click(page.getByRole("button", { name: "Create key" }));

    await expect.element(page.getByText("API key created")).toBeVisible();
    const key = page.getByTestId("api-key");
    await expect.poll(() => key.element().textContent).toMatch(/^bp_\w{20,}$/);
    await userEvent.click(page.getByRole("button", { name: "Copy" }));
    await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await navigator.clipboard.readText()).toBe(key.element().textContent);
    await userEvent.click(page.getByRole("button", { name: "I've saved it" }));
    await expect.element(page.getByTestId("api-key")).not.toBeInTheDocument();

    const row = page.getByRole("list", { name: "API keys" }).getByRole("listitem");
    await expect.element(row).toBeVisible();
    const text = row.element().textContent;
    expect(text).toContain(`Created by ${me.name} on`);
    expect(text).toContain("never used");
    expect(text).toMatch(/expires \w+ \d+, \d{4}/);
    await expect.element(row.getByText("todos:read")).toBeVisible();
    expect(row.getByText("todos:write").query()).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "Revoke: CI" }));
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }));
    await expect.element(page.getByText("“CI” was revoked")).toBeVisible();
    await expect.element(page.getByText("No API keys yet.")).toBeVisible();
  });

  it("shows keys whose creator is gone, that were used, or never expire", async () => {
    await signUp();
    const page = await render();
    await userEvent.fill(page.getByLabelText("Name"), "Old");
    await userEvent.click(page.getByRole("checkbox", { name: /^audit:read/ }));
    await userEvent.click(page.getByRole("button", { name: "Create key" }));
    await expect.element(page.getByTestId("api-key")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId("api-key")).not.toBeInTheDocument();
    await commands.sql(
      `UPDATE auth.api_key SET metadata = $1, last_request = now() - interval '2 hours', expires_at = NULL
       WHERE name = 'Old'`,
      [JSON.stringify({ createdBy: crypto.randomUUID() })],
    );
    cleanup();
    const again = await render();
    const row = again.getByRole("list", { name: "API keys" }).getByRole("listitem");
    await expect.element(row).toBeVisible();
    const text = row.element().textContent;
    expect(text).toContain("by an account that no longer exists");
    expect(text).toContain("last used 2 hours ago");
    expect(text).toContain("never expires");

    // Revoked meanwhile, somewhere else.
    await commands.sql("DELETE FROM auth.api_key WHERE name = 'Old'");
    await userEvent.click(again.getByRole("button", { name: "Revoke: Old" }));
    await userEvent.click(again.getByRole("alertdialog").getByRole("button", { name: "Revoke" }));
    await expect
      .element(again.getByText("That API key doesn't exist in this workspace."))
      .toBeVisible();
  });

  it("says when the workspace has as many keys as it can", async () => {
    await signUp();
    const workspace = await teamWorkspace();
    await commands.sql(
      `INSERT INTO auth.api_key (name, key, reference_id, updated_at)
       SELECT 'Filler ' || n, gen_random_uuid()::text, $1, now() FROM generate_series(1, 50) n`,
      [workspace.id],
    );
    const page = await render();
    await userEvent.fill(page.getByLabelText("Name"), "One more");
    await userEvent.click(page.getByRole("checkbox", { name: /^todos:read/ }));
    await userEvent.click(page.getByRole("button", { name: "Create key" }));
    await expect
      .element(
        page.getByText("This workspace has as many API keys as it can have.", { exact: false }),
      )
      .toBeVisible();
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
