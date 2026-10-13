import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { WorkspaceWebhooksPage } from "@/modules/workspace";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import { setRole, subscribe, teamWorkspace } from "./support";

const render = () => renderPage(<WorkspaceWebhooksPage />, { url: "/settings/webhooks" });

/** A workspace on the plan that includes webhooks. */
async function proWorkspace() {
  const me = await signUp();
  const workspace = await teamWorkspace();
  await subscribe(workspace.id);
  return { me, workspace };
}

describe("webhook endpoints", () => {
  it("asks the free plan to upgrade instead of offering to add one", async () => {
    await signUp();
    await teamWorkspace();
    const page = await render();
    await expect.element(page.getByText("No endpoints yet.")).toBeVisible();
    await expect
      .element(page.getByText("Webhooks are part of Pro.", { exact: false }))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Add endpoint" }).query()).toBeNull();
  });

  it("adds an endpoint for chosen events and shows its signing secret once", async () => {
    await proWorkspace();
    // Its own address: other tests add endpoints to the same database.
    const url = `http://127.0.0.1:9/hooks/${crypto.randomUUID()}`;
    const page = await render();
    await userEvent.fill(page.getByLabelText("Endpoint URL"), "not a url");
    await userEvent.click(page.getByRole("button", { name: "Add endpoint" }));
    await expect
      .element(page.getByLabelText("Endpoint URL"))
      .toHaveAttribute("aria-invalid", "true");

    await userEvent.fill(page.getByLabelText("Endpoint URL"), url);
    await userEvent.fill(page.getByLabelText("Description"), "Our receiver");
    await userEvent.click(page.getByRole("checkbox", { name: /^todo\.created\.v1/ }));
    await userEvent.click(page.getByRole("checkbox", { name: /^todo\.deleted\.v1/ }));
    await userEvent.click(page.getByRole("checkbox", { name: /^todo\.deleted\.v1/ }));
    await userEvent.click(page.getByRole("button", { name: "Add endpoint" }));
    await expect.element(page.getByText("Endpoint added")).toBeVisible();
    await expect
      .poll(() => page.getByTestId("webhook-secret").element().textContent)
      .toMatch(/^whsec_/);
    await userEvent.click(page.getByRole("button", { name: "I've saved it" }));

    const link = page.getByRole("link", { name: url });
    await expect.element(link).toBeVisible();
    await expect.element(page.getByText("Active")).toBeVisible();
    const [endpoint] = await commands.sql<{ id: string; events: string[] }>(
      "SELECT id::text, events FROM webhooks.endpoint WHERE url = $1",
      [url],
    );
    expect(endpoint?.events).toEqual(["todo.created.v1"]);
    await userEvent.click(link);
    await expect.poll(currentUrl).toBe(`/settings/webhooks/${endpoint?.id}`);
  });

  it("refuses an address inside the network", async () => {
    await proWorkspace();
    const page = await render();
    await userEvent.fill(page.getByLabelText("Endpoint URL"), "http://10.0.0.1/hooks");
    await userEvent.click(page.getByRole("button", { name: "Add endpoint" }));
    await expect
      .element(page.getByText("Use a public https:// URL.", { exact: false }))
      .toBeVisible();
  });

  it("marks endpoints that were turned off, by hand or for failing", async () => {
    const { workspace } = await proWorkspace();
    for (const reason of ["manual", "failing"]) {
      await commands.sql(
        `INSERT INTO webhooks.endpoint (org_id, url, secret, disabled_at, disabled_reason, updated_at)
         VALUES ($1, $2, 'x', now(), $3, now())`,
        [workspace.id, `http://127.0.0.1:9/${reason}`, reason],
      );
    }
    const page = await render();
    await expect.element(page.getByText("Turned off", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Turned off: kept failing")).toBeVisible();
  });

  it("is for owners and admins", async () => {
    const { me, workspace } = await proWorkspace();
    await setRole(workspace.id, me.id, "member");
    const page = await render();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("You don't have permission to do that.");
  });
});
