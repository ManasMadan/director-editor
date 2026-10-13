import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Webhook } from "standardwebhooks";
import { createWorkspace, expect, signUp, test, upgrade } from "./support";

/** The event type a delivery's body names. */
const eventType = (body = "{}") => (JSON.parse(body) as { type?: string }).type;

/** A local endpoint that records what it receives (the stack allows 127.0.0.1 in development). */
async function receiver() {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return { url, received, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("add an endpoint, receive signed events, replay, test, rotate and delete", async ({
  page,
}) => {
  // Four trips through the whole asynchronous pipeline.
  test.slow();
  const hook = await receiver();
  await signUp(page);
  await createWorkspace(page, "Hooked");
  await upgrade(page);

  await page.goto("/settings/webhooks");
  await expect(page.getByText("No endpoints yet.")).toBeVisible();
  await page.getByLabel("Endpoint URL").fill(hook.url);
  await page.getByRole("button", { name: "Add endpoint" }).click();
  const secretDialog = page.getByRole("dialog", { name: "Signing secret" });
  const secret = (await secretDialog.getByTestId("webhook-secret").textContent()) ?? "";
  expect(secret).toMatch(/^whsec_/);
  await secretDialog.getByRole("button", { name: "I've saved it" }).click();

  // A real event, all the way through: api → outbox → worker relay → webhooks → receiver.
  await page.goto("/dashboard");
  await page.getByPlaceholder("What needs doing?").fill("Hooked task");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => hook.received.length, { timeout: 20_000 }).toBe(1);
  const [first] = hook.received;
  const verified = new Webhook(secret).verify(
    first?.body ?? "",
    first?.headers as Record<string, string>,
  );
  expect(verified).toMatchObject({ type: "todo.created.v1", data: { title: "Hooked task" } });

  await page.goto("/settings/webhooks");
  await page.getByRole("link", { name: hook.url }).click();
  const deliveries = page.getByRole("list", { name: "Recent deliveries" });
  await expect(deliveries.getByText("Delivered")).toBeVisible();
  await deliveries.getByRole("button", { name: "Send again" }).click();
  await expect.poll(() => hook.received.length, { timeout: 20_000 }).toBe(2);
  expect(hook.received[1]?.headers["webhook-id"]).toBe(first?.headers["webhook-id"]);

  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("Turned off", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send test event" })).toBeDisabled();
  await page.getByRole("button", { name: "Turn on" }).click();
  await page.getByRole("button", { name: "Send test event" }).click();
  await expect.poll(() => hook.received.length, { timeout: 20_000 }).toBe(3);
  expect(eventType(hook.received[2]?.body)).toBe("webhook.test");

  await page.getByRole("button", { name: "Rotate secret" }).click();
  const rotated = (await page.getByTestId("webhook-secret").textContent()) ?? "";
  expect(rotated).toMatch(/^whsec_/);
  expect(rotated).not.toBe(secret);
  await page.getByRole("button", { name: "I've saved it" }).click();

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/settings\/webhooks$/);
  await expect(page.getByText("No endpoints yet.")).toBeVisible();
  await hook.close();
});

test("private addresses are refused with an explanation", async ({ page }) => {
  await signUp(page);
  await upgrade(page);
  await page.goto("/settings/webhooks");
  await page.getByLabel("Endpoint URL").fill("http://10.0.0.1/hook");
  await page.getByRole("button", { name: "Add endpoint" }).click();
  await expect(
    page.getByText(
      "Use a public https:// URL. Private and internal addresses can't receive webhooks.",
    ),
  ).toBeVisible();
});

test("only chosen events are sent", async ({ page }) => {
  const hook = await receiver();
  await signUp(page);
  await createWorkspace(page, "Picky");
  await upgrade(page);
  await page.goto("/settings/webhooks");
  await page.getByLabel("Endpoint URL").fill(hook.url);
  await page.getByRole("checkbox", { name: /todo\.completed\.v1/ }).check();
  await page.getByRole("button", { name: "Add endpoint" }).click();
  await page.getByRole("button", { name: "I've saved it" }).click();

  await page.goto("/dashboard");
  await page.getByPlaceholder("What needs doing?").fill("Only on completion");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("checkbox", { name: "Only on completion" }).click();
  await expect.poll(() => hook.received.length, { timeout: 20_000 }).toBe(1);
  expect(eventType(hook.received[0]?.body)).toBe("todo.completed.v1");
  await hook.close();
});
