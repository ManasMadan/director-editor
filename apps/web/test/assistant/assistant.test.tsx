import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { AssistantPage } from "@/modules/assistant";
import { cleanup, renderPage } from "../render";
import { api, auth, sharedWorkspace, signIn, signOut, signUp } from "../users";

const question = (page: Awaited<ReturnType<typeof renderPage>>) =>
  page.getByRole("textbox", { name: "Your question" });

describe("asking the assistant", () => {
  it("streams the answer and says where it came from", async () => {
    await signUp();
    const page = await renderPage(<AssistantPage />, { url: "/assistant" });
    await userEvent.click(page.getByRole("button", { name: "Ask" }));
    await expect.element(question(page)).toHaveAttribute("aria-invalid", "true");

    await userEvent.fill(question(page), "How long do refunds take?");
    await userEvent.click(page.getByRole("button", { name: "Ask" }));
    await expect.element(page.getByTestId("answer")).toHaveTextContent("Refunds take five days.");
    await expect.element(page.getByText("From: Handbook")).toBeVisible();
  });

  it("asks on Enter, and starts a new line on Shift+Enter", async () => {
    await signUp();
    const page = await renderPage(<AssistantPage />, { url: "/assistant" });
    await userEvent.click(question(page));
    await userEvent.keyboard("Refunds?{Shift>}{Enter}{/Shift}");
    await expect.element(question(page)).toHaveValue("Refunds?\n");
    expect(page.getByTestId("answer").query()).toBeNull();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByTestId("answer")).toHaveTextContent("Refunds take five days.");
  });

  it("says why an answer was refused or broke off", async () => {
    await signUp();
    const page = await renderPage(<AssistantPage />, { url: "/assistant" });
    await userEvent.fill(question(page), "[budget] anything");
    await userEvent.click(page.getByRole("button", { name: "Ask" }));
    await expect
      .element(page.getByText("used this month's assistant allowance", { exact: false }))
      .toBeVisible();

    await userEvent.fill(question(page), "[broken] anything");
    await userEvent.click(page.getByRole("button", { name: "Ask" }));
    await expect.element(page.getByTestId("answer")).toHaveTextContent("Refunds take five days.");
    await expect
      .element(
        page.getByText("That question needed more work than one answer allows.", { exact: false }),
      )
      .toBeVisible();
  });
});

describe("the assistant's documents", () => {
  it("adds documents and shows how far along each is", async () => {
    await signUp();
    const page = await renderPage(<AssistantPage />, { url: "/assistant" });
    await expect.element(page.getByText("No documents yet.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Add document" }));
    await expect.element(page.getByLabelText("Text")).toHaveAttribute("aria-invalid", "true");

    await userEvent.fill(page.getByLabelText("Title"), "Handbook [ready]");
    await userEvent.fill(page.getByLabelText("Text"), "Refunds take five days.");
    await userEvent.click(page.getByRole("button", { name: "Add document" }));
    await expect
      .element(page.getByText("Document added. It will be ready in a moment."))
      .toBeVisible();
    await expect.element(page.getByLabelText("Title")).toHaveValue("");
    await expect.element(page.getByText("3 passages")).toBeVisible();
    await expect.element(page.getByText("A summary of Handbook [ready]")).toBeVisible();
    await expect.element(page.getByText("Ready")).toBeVisible();

    await api.ai.addDocument({ title: "Scan [failed]", content: "…" });
    await api.ai.addDocument({ title: "Notes", content: "…" });
    cleanup();
    const fresh = await renderPage(<AssistantPage />, { url: "/assistant" });
    await expect.element(fresh.getByText("Failed").first()).toBeVisible();
    await expect.element(fresh.getByText("Waiting").first()).toBeVisible();
    await expect
      .element(
        fresh.getByText("This document couldn't be prepared for the assistant.", { exact: false }),
      )
      .toBeVisible();
  });

  it("removes a document", async () => {
    await signUp();
    await api.ai.addDocument({ title: "Old notes", content: "…" });
    const page = await renderPage(<AssistantPage />, { url: "/assistant" });
    await userEvent.click(page.getByRole("button", { name: "Remove: Old notes" }));
    await expect.element(page.getByText("Document removed")).toBeVisible();
    await expect.element(page.getByText("No documents yet.")).toBeVisible();
  });

  it("says why adding or removing didn't work", async () => {
    await signUp();
    await api.ai.addDocument({ title: "Kept", content: "…" });
    const page = await renderPage(<AssistantPage />, { url: "/assistant" });
    await expect.element(page.getByText("Kept")).toBeVisible();
    await commands.failRequests("/rpc/ai/");
    await userEvent.click(page.getByRole("button", { name: "Remove: Kept" }));
    const unreachable = page.getByText(
      "We can't reach the server. Check your connection and try again.",
    );
    await expect.element(unreachable).toBeVisible();
    await userEvent.fill(page.getByLabelText("Title"), "New");
    await userEvent.fill(page.getByLabelText("Text"), "…");
    await userEvent.click(page.getByRole("button", { name: "Add document" }));
    await expect.poll(() => unreachable.all().length).toBe(2);
    await expect.element(page.getByLabelText("Title")).toHaveValue("New");
  });

  it("lets members remove only their own documents", async () => {
    const owner = await signUp();
    await signOut();
    const member = await signUp();
    await signOut();
    const workspace = await sharedWorkspace(owner, member);
    await api.ai.addDocument({ title: "Mine", content: "…" });
    await signIn(owner);
    await auth("/organization/set-active", { organizationId: workspace.id });
    await api.ai.addDocument({ title: "The owner's", content: "…" });
    await signIn(member);
    await auth("/organization/set-active", { organizationId: workspace.id });
    const page = await renderPage(<AssistantPage />, { url: "/assistant" });
    await expect.element(page.getByText("The owner's")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Remove: Mine" })).toBeVisible();
    expect(page.getByRole("button", { name: "Remove: The owner's" }).query()).toBeNull();
  });
});
