import { expect, signUp, test } from "./support";

test("create, complete and delete a todo", async ({ page }) => {
  await signUp(page);
  const input = page.getByPlaceholder("What needs doing?");
  await expect(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
  await input.fill("Write the demo");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(input).toHaveValue("");

  const todo = page.getByRole("checkbox", { name: "Write the demo" });
  await todo.click();
  await expect(todo).toBeChecked();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Write the demo" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Write the demo" }).click();
  await expect(page.getByRole("checkbox", { name: "Write the demo" })).not.toBeChecked();

  await page.getByRole("button", { name: "Delete Write the demo" }).click();
  await expect(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
});

test("titles are validated with the API's schema", async ({ page }) => {
  await signUp(page);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Todos" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.getByPlaceholder("What needs doing?").fill("x".repeat(201));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Todos" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("long lists load page by page", async ({ page }) => {
  await signUp(page);
  for (let i = 1; i <= 23; i++) {
    const response = await page.request.post("/api/v1/todos", { data: { title: `Item ${i}` } });
    expect(response.status()).toBe(201);
  }
  await page.reload();
  await expect(page.getByRole("checkbox")).toHaveCount(20);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(23);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  // Newest first.
  await expect(page.getByRole("checkbox").first()).toHaveAccessibleName("Item 23");
});

test("a stale edit is refused and the latest version is shown", async ({ page }) => {
  // Without live updates (a missed message, or a stream that's reconnecting), this page
  // keeps showing the old version, so the server has to catch the conflict.
  await page.route("**/rpc/realtime/**", (route) => route.abort());
  await signUp(page);
  const created = await page.request.post("/api/v1/todos", { data: { title: "Shared task" } });
  const todo = (await created.json()) as { id: string; version: number };
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Shared task" })).not.toBeChecked();

  // Someone else completes it while this page still shows the old version.
  const changed = await page.request.patch(`/api/v1/todos/${todo.id}`, {
    data: { completed: true, version: todo.version },
  });
  expect(changed.status()).toBe(200);

  // This page's change carries the stale version: rejected, not applied blindly.
  await page.getByRole("checkbox", { name: "Shared task" }).click();
  await expect(
    page.getByText("Someone else changed this todo. We've loaded the latest version."),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Shared task" })).toBeChecked();
});

test("sentiment runs in the Python service", async ({ page }) => {
  await signUp(page);
  await page
    .getByRole("textbox", { name: "Sentiment (Python)" })
    .fill("I love this, it's wonderful and great");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText(/% confidence · model /)).toBeVisible();
  await expect(page.getByText("Positive", { exact: true })).toBeVisible();
});
