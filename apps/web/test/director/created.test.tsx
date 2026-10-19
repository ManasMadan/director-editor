/**
 * A template the member described: Director writing it, why it couldn't, then its shots
 * to change (reword, retime, move, delete, add) and save, or go and shoot.
 */
import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { CreatedPage } from "@/modules/director";
import { renderPage } from "../render";
import { currentSession, signUp } from "../users";
import { newVideoId, planShot, shotPlan } from "./support";

const openCreated = (videoId: string) =>
  renderPage(<CreatedPage videoId={videoId} />, { url: `/create/${videoId}` });

/** A member of a workspace of their own, and its id (the AI stand-in keeps a brief each). */
async function member() {
  await signUp();
  const { session } = await currentSession();
  return String(session.activeOrganizationId);
}

/** A described template's plan as Director serves it, written and ready to change. */
async function readyCreated(shots = [planShot({ title: "Pour the coffee" })]) {
  const videoId = newVideoId();
  const id = crypto.randomUUID();
  await commands.fakeDirector(videoId, {
    plan: {
      id,
      source: "created",
      status: "ready",
      stage: "ready",
      plan: shotPlan({ title: "Cosy morning", summary: "Coffee by the window.", shots }),
      // The first shot's card is drawn; the second's still being drawn.
      storyboards: [
        {
          shotIndex: 0,
          status: "ready",
          objectKey: `director-assets/${id}/shot-0123456789abcdef.png`,
        },
        { shotIndex: 1, status: "generating", objectKey: null },
      ],
    },
  });
  return videoId;
}

describe("a template you described", () => {
  it("shows Director writing the shots until they're ready", async () => {
    await signUp();
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, {
      plan: { source: "created", status: "pending", stage: "writing", plan: null },
    });
    const page = await openCreated(videoId);
    await expect
      .element(page.getByRole("status", { name: "Director is writing your shots" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Back to the library" }))
      .toHaveAttribute("href", "/library");
  });

  it.each([
    [
      "DIRECTOR_CREATE_FAILED",
      "Director couldn't write your shots this time. Try describing it again.",
    ],
    [null, "Director couldn't write your shots this time. Try describing it again."],
  ])(
    "says why Director couldn't write them (%s), and offers to describe it again",
    async (error, message) => {
      await signUp();
      const videoId = newVideoId();
      await commands.fakeDirector(videoId, {
        plan: { source: "created", status: "failed", stage: "failed", error, plan: null },
      });
      const page = await openCreated(videoId);
      await expect.element(page.getByRole("alert")).toHaveTextContent(message);
      await expect
        .element(page.getByText("Nothing was used up. Try describing it again."))
        .toBeVisible();
      await expect
        .element(page.getByRole("link", { name: "Describe it again" }))
        .toHaveAttribute("href", "/create");
    },
  );

  it("says a template that isn't there isn't in the library, with no promise about the limit", async () => {
    await signUp();
    const page = await openCreated(newVideoId());
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This Short isn't in your library yet.");
    expect(page.getByText("Nothing was used up. Try describing it again.").query()).toBeNull();
    await expect.element(page.getByRole("link", { name: "Describe it again" })).toBeVisible();
  });

  it("changes the shots and saves them, then offers to shoot", async () => {
    const orgId = await member();
    const videoId = await readyCreated([
      planShot({ title: "Pour the coffee", scene: "Kitchen counter", durationSeconds: 3 }),
      planShot({ title: "Sip by the window", scene: "Window seat", durationSeconds: 2 }),
    ]);
    const page = await openCreated(videoId);
    await expect.element(page.getByRole("heading", { name: "Cosy morning" })).toBeVisible();
    await expect.element(page.getByText("Coffee by the window.")).toBeVisible();
    await expect
      .element(page.getByRole("img", { name: "Storyboard for shot 1" }))
      .toHaveAttribute("src", expect.stringContaining("shot-0123456789abcdef.png"));
    // The second card isn't drawn yet.
    expect(page.getByRole("img", { name: "Storyboard for shot 2" }).query()).toBeNull();
    await expect
      .element(page.getByRole("link", { name: "Looks good, let's shoot" }))
      .toHaveAttribute("href", `/director/${videoId}`);
    // The first shot can't move up, the last can't move down.
    await expect.element(page.getByRole("button", { name: "Move shot 1 up" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Move shot 2 down" })).toBeDisabled();

    const titles = page.getByRole("textbox", { name: "What happens" });
    const scenes = page.getByRole("textbox", { name: "Where" });
    const seconds = page.getByRole("spinbutton", { name: "Seconds" });
    await userEvent.fill(titles.nth(0), "Pour it slowly");
    await userEvent.fill(scenes.nth(0), "By the kettle");
    await userEvent.fill(seconds.nth(0), "4.5");
    // Past the longest a shot may be: the last good length stays.
    await userEvent.fill(seconds.nth(1), "61");
    await userEvent.click(page.getByRole("button", { name: "Move shot 2 up" }));
    await expect.element(titles.nth(0)).toHaveValue("Sip by the window");
    await userEvent.click(page.getByRole("button", { name: "Move shot 1 down" }));
    await expect.element(titles.nth(0)).toHaveValue("Pour it slowly");
    await userEvent.click(page.getByRole("button", { name: "Add a shot" }));
    await expect.element(titles.nth(2)).toHaveValue("A new shot");
    await expect.element(scenes.nth(2)).toHaveValue("Anywhere with good light");
    await userEvent.click(page.getByRole("button", { name: "Delete shot 2" }));
    await expect.element(titles.nth(1)).toHaveValue("A new shot");

    // A shot that doesn't say what happens can't be saved.
    const save = page.getByRole("button", { name: "Save changes" });
    await userEvent.fill(titles.nth(1), " ");
    await expect.element(save).toBeDisabled();
    await userEvent.fill(titles.nth(1), "Wave goodbye");
    await userEvent.click(save);
    await expect.element(page.getByText("Saved")).toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "Looks good, let's shoot" })).toBeVisible();

    const [edit] = (await commands.fakeBrief(orgId)).filter(
      ({ route }) => route === "PUT /v1/director/created",
    );
    expect(edit?.body).toMatchObject({
      videoId,
      plan: {
        title: "Cosy morning",
        shots: [
          { title: "Pour it slowly", scene: "By the kettle", durationSeconds: 4.5 },
          { title: "Wave goodbye", scene: "Anywhere with good light" },
        ],
      },
    });
  });

  it("says why the changes weren't saved, keeping them", async () => {
    await signUp();
    const page = await openCreated(await readyCreated());
    const title = page.getByRole("textbox", { name: "What happens" });
    await userEvent.fill(title, "Pour it slowly");
    await commands.failRequests("/rpc/director/editPlan");
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");
    await expect.element(title).toHaveValue("Pour it slowly");
    // A plan's only shot can't be deleted.
    await expect.element(page.getByRole("button", { name: "Delete shot 1" })).toBeDisabled();
  });

  it("adds no shot past the most a plan may have", async () => {
    await signUp();
    const page = await openCreated(
      await readyCreated(Array.from({ length: 12 }, (_, at) => planShot({ title: `Shot ${at}` }))),
    );
    await expect.element(page.getByRole("button", { name: "Delete shot 12" })).toBeVisible();
    expect(page.getByRole("button", { name: "Add a shot" }).query()).toBeNull();
  });
});
