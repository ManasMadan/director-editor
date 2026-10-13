import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { DashboardPage } from "@/modules/dashboard";
import { renderPage } from "../render";
import { api, signOut, signUp } from "../users";

describe("the dashboard", () => {
  it("greets the user and starts with no todos", async () => {
    const user = await signUp();
    const page = await renderPage(<DashboardPage />, { url: "/dashboard" });
    await expect.element(page.getByRole("heading", { name: `Hi ${user.name}` })).toBeVisible();
    await expect.element(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
  });

  it("adds, completes and deletes todos", async () => {
    await signUp();
    const page = await renderPage(<DashboardPage />, { url: "/dashboard" });
    const title = page.getByRole("textbox", { name: "Todos" });
    await userEvent.click(page.getByRole("button", { name: "Add" }));
    await expect.element(page.getByText("Too small", { exact: false })).toBeVisible();

    await userEvent.fill(title, "Water the plants");
    await userEvent.click(page.getByRole("button", { name: "Add" }));
    const todo = page.getByRole("checkbox", { name: "Water the plants" });
    await expect.element(todo).not.toBeChecked();
    await expect.element(title).toHaveValue("");

    await userEvent.click(todo);
    await expect.element(todo).toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Delete Water the plants" }));
    await expect.element(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
  });

  it("loads older todos page by page", async () => {
    await signUp();
    for (let index = 1; index <= 21; index++) {
      await api.todo.create({ title: `Todo ${index}` });
    }
    const page = await renderPage(<DashboardPage />, { url: "/dashboard" });
    await expect.element(page.getByText("Todo 21")).toBeVisible();
    expect(page.getByText("Todo 1", { exact: true }).query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Load more" }));
    await expect.element(page.getByText("Todo 1", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("says why a change didn't go through", async () => {
    await signUp();
    const { id } = await api.todo.create({ title: "Changed elsewhere" });
    const page = await renderPage(<DashboardPage />, { url: "/dashboard" });
    const todo = page.getByRole("checkbox", { name: "Changed elsewhere" });
    await expect.element(todo).toBeVisible();

    // Another tab completed it: this one's copy is out of date.
    const [current] = (await api.todo.list({ limit: 1 })).items;
    await api.todo.setCompleted({ id, completed: true, version: current?.version ?? 0 });
    await userEvent.click(todo);
    await expect
      .element(page.getByText("Someone else changed this todo. We've loaded the latest version."))
      .toBeVisible();

    await api.todo.delete({ id });
    await userEvent.click(page.getByRole("button", { name: "Delete Changed elsewhere" }));
    await expect.element(page.getByText("That todo no longer exists.")).toBeVisible();
  });

  it("keeps what was typed when adding fails", async () => {
    await signUp();
    const page = await renderPage(<DashboardPage />, { url: "/dashboard" });
    await expect.element(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
    await signOut();
    await userEvent.fill(page.getByRole("textbox", { name: "Todos" }), "Lost?");
    await userEvent.click(page.getByRole("button", { name: "Add" }));
    await expect.element(page.getByText("Please sign in to continue.")).toBeVisible();
  });
});

describe("sentiment", () => {
  it("classifies text through the AI service", async () => {
    await signUp();
    const page = await renderPage(<DashboardPage />, { url: "/dashboard" });
    const text = page.getByRole("textbox", { name: "Sentiment (Python)" });
    const analyze = page.getByRole("button", { name: "Analyze" });
    await expect.element(analyze).toBeDisabled();
    await userEvent.fill(text, "What a lovely day");
    await userEvent.click(analyze);
    await expect.element(page.getByText("Positive")).toBeVisible();
    await expect
      .element(page.getByText("87% confidence · model stand-in", { exact: false }))
      .toBeVisible();
  });

  it("says why it couldn't", async () => {
    await signUp();
    const page = await renderPage(<DashboardPage />, { url: "/dashboard" });
    await userEvent.fill(page.getByRole("textbox", { name: "Sentiment (Python)" }), "Hmm");
    await signOut();
    await userEvent.click(page.getByRole("button", { name: "Analyze" }));
    await expect.element(page.getByText("Please sign in to continue.")).toBeVisible();
  });
});
