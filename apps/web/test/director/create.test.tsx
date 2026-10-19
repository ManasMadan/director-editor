/**
 * Describing a template of your own: the brief survives a reload, a short talk with
 * Director (typed or said) that stays in view while it thinks, and the shots written
 * from it; a turn Director couldn't answer is taken back so the talk never has two of
 * the member's in a row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page as browserPage, commands, userEvent } from "vitest/browser";
import { CreatePage } from "@/modules/director";
import { cleanup, currentUrl, renderPage } from "../render";
import { currentSession, signUp } from "../users";
import { FakeRecognizer, fakeRecognizer } from "./support";

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

/** A member of a workspace of their own, and its id (the AI stand-in keeps a brief each). */
async function member() {
  const user = await signUp();
  const { session } = await currentSession();
  return { user, orgId: String(session.activeOrganizationId) };
}

const reply = (text: string, ready = false) => ({
  reply: text,
  ready,
  questionsLeft: ready ? 0 : 2,
});

/** A brief kept in this tab, as the page keeps it. */
const keepBrief = (userId: string, brief: { text: string; messages: object[] }) =>
  window.sessionStorage.setItem(`director.create.${userId}`, JSON.stringify(brief));

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
    keepBrief(member.id, {
      text: "My morning coffee",
      messages: [{ role: "director", text: "Where do you drink it?" }],
    });
    const page = await openCreate();
    const talk = page.getByRole("region", { name: "Your talk with Director" });
    await expect
      .element(talk.getByRole("listitem"))
      .toHaveTextContent("Director: Where do you drink it?");
    const answer = page.getByRole("textbox", { name: "Your answer" });
    await userEvent.fill(answer, "By the window");
    await userEvent.click(page.getByRole("button", { name: "Send" }));
    // Director has no reply set for this workspace: it can't answer.
    await expect.element(page.getByRole("alert")).toBeVisible();
    // Only Director's question is left in the talk.
    expect(talk.getByRole("listitem").elements()).toHaveLength(1);
    await expect.element(answer).toHaveValue("By the window");
  });

  it("talks it through with Director, then writes the shots and opens them", async () => {
    const { user, orgId } = await member();
    await commands.fakeBrief(orgId, {
      replies: [
        reply("Lovely. Where do you drink it?"),
        reply("Got it: a slow, cosy morning by the window.", true),
      ],
    });
    const page = await openCreate();
    const talkButton = page.getByRole("button", { name: "Talk it through" });
    // Nothing to talk about yet.
    await expect.element(talkButton).toBeDisabled();
    await userEvent.fill(page.getByRole("textbox", { name: "Your idea" }), "  My morning coffee ");
    await userEvent.click(talkButton);
    const talk = page.getByRole("region", { name: "Your talk with Director" });
    await expect
      .element(talk.getByRole("listitem"))
      .toHaveTextContent("Director: Lovely. Where do you drink it?");

    // An answer of only spaces isn't sent, even with Enter.
    const answer = page.getByRole("textbox", { name: "Your answer" });
    await userEvent.fill(answer, "   ");
    await expect.element(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.type(answer, "{Enter}");
    // Nor when the form is sent past its disabled button (a script, an assistive tool).
    (answer.element().closest("form") as HTMLFormElement).requestSubmit();
    expect(await commands.fakeBrief(orgId)).toHaveLength(1);
    expect(talk.getByRole("listitem").elements()).toHaveLength(1);

    await userEvent.fill(answer, "  By the window ");
    await userEvent.type(answer, "{Enter}");
    await expect
      .element(talk.getByRole("listitem").nth(2))
      .toHaveTextContent("Director: Got it: a slow, cosy morning by the window.");
    expect(talk.getByRole("listitem").nth(1).element()).toHaveTextContent("You: By the window");
    // Director has what it needs: no more questions.
    expect(page.getByRole("textbox", { name: "Your answer" }).query()).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "Write my shots" }));
    await expect.poll(currentUrl).toMatch(/^\/create\/[\w-]{11}$/);
    // The brief became a template: a reload of /create starts afresh.
    expect(window.sessionStorage.getItem(`director.create.${user.id}`)).toBeNull();

    const sent = await commands.fakeBrief(orgId);
    expect(sent.map(({ route }) => route)).toEqual([
      "POST /v1/director/brainstorm",
      "POST /v1/director/brainstorm",
      "POST /v1/director/created",
    ]);
    expect(sent[0]?.body).toMatchObject({ text: "My morning coffee", messages: [], photos: [] });
    expect(sent[2]?.body).toMatchObject({
      text: "My morning coffee",
      messages: [
        { role: "director", text: "Lovely. Where do you drink it?" },
        { role: "member", text: "By the window" },
        { role: "director", text: "Got it: a slow, cosy morning by the window." },
      ],
      photos: [],
    });
  });

  it("asks nothing more once the talk is as long as a brief may be", async () => {
    const member = await signUp();
    const turns = ["Where?", "Kitchen", "When?", "Morning", "Music?", "Jazz", "Length?"];
    keepBrief(member.id, {
      text: "Coffee",
      messages: turns.map((text, index) => ({
        role: index % 2 === 0 ? "director" : "member",
        text,
      })),
    });
    const page = await openCreate();
    const talk = page.getByRole("region", { name: "Your talk with Director" });
    await expect.element(talk.getByRole("listitem").nth(6)).toHaveTextContent("Director: Length?");
    // No room for an answer and Director's reply to it: the shots can still be written.
    expect(page.getByRole("textbox", { name: "Your answer" }).query()).toBeNull();
    await expect.element(page.getByRole("button", { name: "Write my shots" })).toBeEnabled();
  });

  it("says why the shots couldn't be written, and stays on the brief", async () => {
    const member = await signUp();
    keepBrief(member.id, { text: "My morning coffee", messages: [] });
    const page = await openCreate();
    await commands.failRequests("/rpc/director/create");
    await userEvent.click(page.getByRole("button", { name: "Write my shots" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");
    expect(currentUrl()).toBe("/create");
    await expect
      .element(page.getByRole("textbox", { name: "Your idea" }))
      .toHaveValue("My morning coffee");
  });

  it("takes the idea and the answers said out loud, where the browser can listen", async () => {
    fakeRecognizer();
    const member = await signUp();
    keepBrief(member.id, {
      text: "My morning coffee",
      messages: [{ role: "director", text: "Where do you drink it?" }],
    });
    const page = await openCreate();
    const mic = (at: number) =>
      page.getByRole("button", { name: "Say it instead of typing" }).nth(at);

    await userEvent.click(mic(0));
    await expect
      .element(page.getByRole("button", { name: "Stop listening" }))
      .toHaveAttribute("aria-pressed", "true");
    FakeRecognizer.last?.hear("cosy, no talking");
    await expect
      .element(page.getByRole("textbox", { name: "Your idea" }))
      .toHaveValue("My morning coffee cosy, no talking");
    await userEvent.click(page.getByRole("button", { name: "Stop listening" }));

    await userEvent.click(mic(1));
    FakeRecognizer.last?.hear("By the window");
    await expect
      .element(page.getByRole("textbox", { name: "Your answer" }))
      .toHaveValue("By the window");
  });

  it("keeps nothing in the tab when it can't tell who's signed in, and still writes the shots", async () => {
    await signUp();
    // The session reads as nobody's (the cookie still works): whose draft it is isn't known.
    await commands.failRequests("/api/auth/get-session", { status: 200, body: null });
    const page = await openCreate();
    await userEvent.fill(page.getByRole("textbox", { name: "Your idea" }), "My morning coffee");
    await userEvent.click(page.getByRole("button", { name: "Write my shots" }));
    await expect.poll(currentUrl).toMatch(/^\/create\/[\w-]{11}$/);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps nothing in the tab for someone signed out, and sends them to sign in", async () => {
    await openCreate();
    await expect.poll(currentUrl).toBe("/sign-in?next=%2Fcreate");
    expect(window.sessionStorage.length).toBe(0);
  });
});

// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

const photoInput = () =>
  browserPage.elementLocator(document.querySelector("input[type=file]") as HTMLElement);

/** The member's brief photos the API recorded, oldest first. */
const briefPhotos = (userId: string) =>
  commands.sql<{ id: string; status: string }>(
    `SELECT id::text, status FROM files.file
      WHERE user_id = $1 AND purpose = 'director-brief-photo' ORDER BY created_at`,
    [userId],
  );

// Uploads go to RustFS: the files profile (`bun run test:integration:files`).
describe("a brief's photos", { tags: ["files"] }, () => {
  it("sends Director the photos that uploaded, and waits for the ones still being checked", async () => {
    await commands.storageCors();
    const { user, orgId } = await member();
    await commands.fakeBrief(orgId, { replies: [reply("Nice light. Morning or evening?")] });
    const page = await openCreate();
    await userEvent.fill(page.getByRole("textbox", { name: "Your idea" }), "My morning coffee");

    // The first one never reaches storage.
    await commands.refuseNextPut(503);
    await userEvent.upload(photoInput(), new File([PNG], "a.png", { type: "image/png" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("That photo didn't upload. Remove it and try another.");

    await userEvent.upload(photoInput(), new File([PNG], "b.png", { type: "image/png" }));
    let fileId = "";
    await expect
      .poll(async () => {
        fileId = (await briefPhotos(user.id)).at(-1)?.id ?? "";
        return fileId;
      })
      .not.toBe("");
    // Still being checked: nothing can be sent yet.
    await expect.element(page.getByRole("button", { name: "Talk it through" })).toBeDisabled();
    await commands.checkUpload(fileId);
    await expect.element(page.getByRole("button", { name: "Talk it through" })).toBeEnabled();

    await userEvent.click(page.getByRole("button", { name: "Talk it through" }));
    await expect
      .element(page.getByRole("region", { name: "Your talk with Director" }))
      .toHaveTextContent("Director: Nice light. Morning or evening?");
    const [turn] = await commands.fakeBrief(orgId);
    expect(turn?.body.photos).toEqual([{ fileId, url: expect.any(String) }]);
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
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", behavior: "smooth" });
    await expect.element(page.getByLabelText("Your answer")).toBeVisible();
  });

  it("brings the talk into view without the glide for a member who asked for less motion", async () => {
    await signUp();
    await answers("Hands only, or you on camera too?");
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) =>
      query === "(prefers-reduced-motion: reduce)"
        ? { ...matchMedia(query), matches: true }
        : matchMedia(query),
    );
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const page = await openCreate();
    await userEvent.fill(page.getByLabelText("Your idea"), "My morning coffee, no talking");
    await userEvent.click(page.getByRole("button", { name: "Talk it through" }));
    await expect
      .poll(() => scroll.mock.calls.at(-1))
      .toEqual([{ block: "nearest", behavior: "auto" }]);
  });
});
