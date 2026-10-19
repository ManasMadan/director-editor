/**
 * Describing a template of your own: the brief survives a reload, a turn Director
 * couldn't answer is taken back so the talk never has two of the member's in a row, and
 * the talk with Director stays in view while it thinks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { CreatePage } from "@/modules/director";
import { cleanup, renderPage } from "../render";
import { signUp } from "../users";

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

const openCreate = () => renderPage(<CreatePage />, { url: "/create" });

/** Director's next turn, as the API answers it. */
const answers = (reply: string) =>
  commands.failRequests("/rpc/director/brainstorm", {
    status: 200,
    body: { json: { reply, ready: false, questionsLeft: 2 } },
  });

/** Whether a status named `name` was ever shown, from now on. */
function watchFor(name: string) {
  let seen = false;
  const observer = new MutationObserver(() => {
    seen ||= [...document.querySelectorAll("[role=status]")].some(
      (status) => status.getAttribute("aria-label") === name && status.textContent?.includes(name),
    );
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    return seen;
  };
}

describe("describing your own", () => {
  it("keeps the idea and the talk in this tab, for the member who wrote them", async () => {
    const member = await signUp();
    const page = await openCreate();
    const idea = page.getByRole("textbox", { name: "Your idea" });
    await userEvent.fill(idea, "My morning coffee, cosy");
    // The tab reloads: the idea is still there.
    cleanup();
    const again = await openCreate();
    await expect
      .element(again.getByRole("textbox", { name: "Your idea" }))
      .toHaveValue("My morning coffee, cosy");
    cleanup();
    // Someone else signs in on this tab: they start afresh.
    await signUp();
    const other = await openCreate();
    await expect.element(other.getByRole("textbox", { name: "Your idea" })).toHaveValue("");
    expect(window.sessionStorage.getItem(`director.create.${member.id}`)).not.toBeNull();
  });

  it("takes back an answer Director couldn't reply to, keeping it in the box to send again", async () => {
    const member = await signUp();
    window.sessionStorage.setItem(
      `director.create.${member.id}`,
      JSON.stringify({
        text: "My morning coffee",
        messages: [{ role: "director", text: "Where do you drink it?" }],
      }),
    );
    const page = await openCreate();
    const talk = page.getByRole("region", { name: "Your talk with Director" });
    await expect
      .element(talk.getByRole("listitem"))
      .toHaveTextContent("Director: Where do you drink it?");
    const answer = page.getByRole("textbox", { name: "Your answer" });
    await userEvent.fill(answer, "By the window");
    await userEvent.click(page.getByRole("button", { name: "Send" }));
    // The AI stand-in has no brainstorm: Director can't answer.
    await expect.element(page.getByRole("alert")).toBeVisible();
    // Only Director's question is left in the talk.
    expect(talk.getByRole("listitem").elements()).toHaveLength(1);
    await expect.element(answer).toHaveValue("By the window");
  });
});

describe("talking an idea through", () => {
  it("says Director is thinking from the first question, and keeps the talk in view", async () => {
    await signUp();
    await answers("Hands only, or you on camera too?");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const page = await openCreate();
    await userEvent.fill(page.getByLabelText("Your idea"), "My morning coffee, no talking");
    const seen = watchFor("Director is thinking…");
    await userEvent.click(page.getByRole("button", { name: "Talk it through" }));
    await expect
      .element(page.getByText("Hands only, or you on camera too?", { exact: false }))
      .toBeVisible();
    // Words with the loader, not a greyed button alone, while the first question comes.
    expect(seen()).toBe(true);
    // The question and the answer field under it are brought into view.
    await expect.poll(() => scroll.mock.calls.length).toBeGreaterThan(0);
    await expect.element(page.getByLabelText("Your answer")).toBeVisible();
  });
});
