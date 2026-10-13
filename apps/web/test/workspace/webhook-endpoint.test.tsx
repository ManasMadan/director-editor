import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { WebhookEndpointPage } from "@/modules/workspace";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import { subscribe, teamWorkspace } from "./support";

async function endpoint(description = "") {
  await signUp();
  const workspace = await teamWorkspace();
  await subscribe(workspace.id);
  const [row] = await commands.sql<{ id: string }>(
    `INSERT INTO webhooks.endpoint (org_id, url, description, secret, updated_at)
     VALUES ($1, 'http://127.0.0.1:9/hooks', $2, 'x', now()) RETURNING id::text`,
    [workspace.id, description],
  );
  return { id: row?.id as string, orgId: workspace.id };
}

const render = (id: string) =>
  renderPage(<WebhookEndpointPage id={id} />, { url: `/settings/webhooks/${id}` });

/** What apps/webhooks records as it sends events to the endpoint. */
async function deliveries(
  endpointId: string,
  orgId: string,
  rows: {
    status: string;
    attempts?: number;
    lastStatus?: number | null;
    lastError?: string | null;
  }[],
) {
  for (const row of rows) {
    await commands.sql(
      `INSERT INTO webhooks.delivery (endpoint_id, org_id, event_id, event_name, body, status, attempts, last_status, last_error)
       VALUES ($1, $2, gen_random_uuid(), 'todo.created.v1', '{}', $3, $4, $5, $6)`,
      [
        endpointId,
        orgId,
        row.status,
        row.attempts ?? 1,
        row.lastStatus ?? null,
        row.lastError ?? null,
      ],
    );
  }
}

describe("a webhook endpoint", () => {
  it("says when it doesn't exist", async () => {
    await signUp();
    const page = await render(crypto.randomUUID());
    await expect.element(page.getByText("That webhook endpoint doesn't exist.")).toBeVisible();
  });

  it("turns off and on, sends a test, rotates its secret and is deleted", async () => {
    const { id } = await endpoint("Our receiver");
    const page = await render(id);
    await expect.element(page.getByText("Our receiver")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "← All endpoints" }))
      .toHaveAttribute("href", "/settings/webhooks");
    await expect.element(page.getByText("Nothing sent yet.")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Send test event" }));
    await expect.element(page.getByText("Test event sent")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Turn off" }));
    await expect.element(page.getByText("Turned off", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Send test event" })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Turn on" }));
    await expect.element(page.getByText("Active")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Rotate secret" }));
    await expect.element(page.getByText("New secret created.", { exact: false })).toBeVisible();
    await expect
      .poll(() => page.getByTestId("webhook-secret").element().textContent)
      .toMatch(/^whsec_/);
    await userEvent.click(page.getByRole("button", { name: "I've saved it" }));

    await userEvent.click(page.getByRole("button", { name: "Delete" }));
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Delete" }));
    await expect.element(page.getByText("Endpoint deleted")).toBeVisible();
    await expect.poll(currentUrl).toBe("/settings/webhooks");
  });

  it("says when it was deleted meanwhile", async () => {
    const { id } = await endpoint();
    const page = await render(id);
    await expect.element(page.getByRole("button", { name: "Turn off" })).toBeVisible();
    await commands.sql("DELETE FROM webhooks.endpoint WHERE id = $1", [id]);
    const gone = page.getByText("That webhook endpoint doesn't exist.");
    for (const action of ["Turn off", "Send test event", "Rotate secret"]) {
      await userEvent.click(page.getByRole("button", { name: action }));
    }
    await userEvent.click(page.getByRole("button", { name: "Delete" }));
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Delete" }));
    await expect.poll(() => gone.all().length).toBeGreaterThanOrEqual(4);
  });

  it("lists deliveries with their outcome, and sends one again", async () => {
    const { id, orgId } = await endpoint();
    await deliveries(id, orgId, [
      { status: "pending", attempts: 0 },
      { status: "succeeded", lastStatus: 200 },
      { status: "failed", attempts: 3, lastError: "timeout" },
      { status: "failed", attempts: 2, lastStatus: 500, lastError: "connection_failed" },
    ]);
    const page = await render(id);
    const list = page.getByRole("list", { name: "Recent deliveries" });
    await expect.element(list.getByText("Sending…")).toBeVisible();
    await expect.element(list.getByText("Delivered")).toBeVisible();
    await expect.element(list.getByText("3 attempts · timed out", { exact: false })).toBeVisible();
    await expect.element(list.getByText("2 attempts · HTTP 500", { exact: false })).toBeVisible();
    await expect.element(list.getByText("1 attempt · HTTP 200", { exact: false })).toBeVisible();
    // One button per finished delivery.
    expect(list.getByRole("button", { name: "Send again" }).all()).toHaveLength(3);
    await userEvent.click(list.getByRole("button", { name: "Send again" }).first());
    await expect.element(page.getByText("Queued to send again")).toBeVisible();

    await commands.sql("DELETE FROM webhooks.delivery WHERE endpoint_id = $1", [id]);
    await userEvent.click(list.getByRole("button", { name: "Send again" }).first());
    await expect.element(page.getByText("That delivery doesn't exist.")).toBeVisible();
  });

  it("loads older deliveries on request", async () => {
    const { id, orgId } = await endpoint();
    await deliveries(
      id,
      orgId,
      Array.from({ length: 21 }, () => ({ status: "succeeded", lastStatus: 204 })),
    );
    const page = await render(id);
    const rows = page.getByRole("list", { name: "Recent deliveries" }).getByRole("listitem");
    await expect.poll(() => rows.all().length).toBe(20);
    await userEvent.click(page.getByRole("button", { name: "Load more" }));
    await expect.poll(() => rows.all().length).toBe(21);
  });
});
