/** A template the member described: its shots, changed and saved as they're changed. */
import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { CreatedPage } from "@/modules/director";
import { cleanup, renderPage } from "../render";
import { api, signUp } from "../users";
import { newVideoId, planShot, shotPlan } from "./support";

const plan = shotPlan({
  shots: [
    planShot({ title: "Pour the coffee", durationSeconds: 2 }),
    planShot({ title: "First sip", durationSeconds: 3 }),
  ],
});

const open = (videoId: string) =>
  renderPage(<CreatedPage videoId={videoId} />, { url: `/create/${videoId}` });

/** A template the member described, its page open. */
async function described() {
  await signUp();
  const videoId = newVideoId();
  await commands.fakeDirector(videoId, { plan: { status: "ready", source: "created", plan } });
  return { videoId, page: await open(videoId) };
}

/** The shots' titles as the API now has them. */
const savedTitles = async (videoId: string) => {
  const plan = await api.director.plan({ videoId });
  return plan.plan?.shots.map((shot) => shot.title);
};

describe("changing the shots of a described template", () => {
  it("saves each change by itself, and says so", async () => {
    const { videoId, page } = await described();
    const title = page.getByLabelText("What happens").first();
    await userEvent.fill(title, "Grind the beans");
    await expect.element(page.getByText("Saving…")).toBeVisible();
    // No button to press: the change is saved a moment after the typing stops.
    expect(page.getByRole("button", { name: "Save changes" }).query()).toBeNull();
    await expect.element(page.getByText("Saved", { exact: true })).toBeVisible();
    expect(await savedTitles(videoId)).toEqual(["Grind the beans", "First sip"]);

    await userEvent.click(page.getByRole("button", { name: "Delete shot 2" }));
    await expect.poll(() => savedTitles(videoId)).toEqual(["Grind the beans"]);
    // Once saved, on to the shoot.
    await expect
      .element(page.getByRole("link", { name: "Looks good, let's shoot" }))
      .toHaveAttribute("href", `/director/${videoId}`);
  });

  it("saves a change at once when the member leaves before its moment", async () => {
    const { videoId, page } = await described();
    await userEvent.fill(page.getByLabelText("What happens").first(), "Steam the milk");
    cleanup();
    await expect.poll(() => savedTitles(videoId)).toEqual(["Steam the milk", "First sip"]);
  });

  it("asks before a reload drops a change not saved yet", async () => {
    const { page } = await described();
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    await userEvent.fill(page.getByLabelText("What happens").first(), "Froth it");
    expect(leave()).toBe(true);
    await expect.element(page.getByText("Saved", { exact: true })).toBeVisible();
    expect(leave()).toBe(false);
  });

  it("says the range for a length out of it, and keeps the last good one", async () => {
    const { videoId, page } = await described();
    const seconds = page.getByLabelText("Seconds").first();
    await userEvent.fill(seconds, "0");
    await expect.element(seconds).toHaveValue(0);
    await expect.element(seconds).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(page.getByText("Between 1 and 60 seconds. It stays at 2 until then."))
      .toBeVisible();
    await userEvent.fill(seconds, "4.5");
    await expect.element(seconds).toHaveAttribute("aria-invalid", "false");
    await expect
      .poll(async () => (await api.director.plan({ videoId })).plan?.shots[0]?.durationSeconds)
      .toBe(4.5);
  });

  it("brings a deleted shot back from the toast", async () => {
    const { videoId, page } = await described();
    await userEvent.click(page.getByRole("button", { name: "Delete shot 2" }));
    await expect.poll(() => savedTitles(videoId)).toEqual(["Pour the coffee"]);
    await userEvent.click(page.getByRole("button", { name: "Undo" }));
    await expect.poll(() => savedTitles(videoId)).toEqual(["Pour the coffee", "First sip"]);
    // The card shows the shot it now holds, its length too.
    await expect.element(page.getByLabelText("Seconds").last()).toHaveValue(3);
  });

  it("won't rewrite a starter's shots, and says a link that can't be a template isn't one", async () => {
    await signUp();
    const starter = newVideoId();
    await commands.fakeDirector(starter, { plan: { status: "ready", source: "seed", plan } });
    const page = await open(starter);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Only a template you described has shots you can change here. This one is filmed as it is.",
      );
    await expect
      .element(page.getByRole("link", { name: "Open the template" }))
      .toHaveAttribute("href", `/director/${starter}`);
    expect(page.getByLabelText("What happens").query()).toBeNull();
    cleanup();
    const bad = await open("doesnotexist");
    await expect
      .element(bad.getByRole("alert"))
      .toHaveTextContent(
        "That link isn't to a template you described. Check it, or describe a new one.",
      );
    await expect
      .element(bad.getByRole("link", { name: "Describe it again" }))
      .toHaveAttribute("href", "/create");
  });

  it("holds a shot with nothing in it unsaved, says why, and keeps the shoot shut", async () => {
    const { videoId, page } = await described();
    await userEvent.fill(page.getByLabelText("What happens").first(), "");
    await expect
      .element(page.getByText("Every shot needs what happens and where before it can be saved."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Looks good, let's shoot" }))
      .toBeDisabled();
    expect(await savedTitles(videoId)).toEqual(["Pour the coffee", "First sip"]);
  });
});

/** A described template written and ready, its first card drawn and the second still drawing. */
async function readyCreated(shots = plan.shots) {
  await signUp();
  const videoId = newVideoId();
  const id = crypto.randomUUID();
  await commands.fakeDirector(videoId, {
    plan: {
      id,
      source: "created",
      status: "ready",
      stage: "ready",
      plan: shotPlan({ title: "Cosy morning", summary: "Coffee by the window.", shots }),
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
  return { videoId, page: await open(videoId) };
}

describe("before the shots are written", () => {
  it("shows Director writing them", async () => {
    await signUp();
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, {
      plan: { source: "created", status: "pending", stage: "writing", plan: null },
    });
    const page = await open(videoId);
    await expect
      .element(page.getByRole("status", { name: "Director is writing your shots" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Back to the library" }))
      .toHaveAttribute("href", "/library");
  });

  it.each([
    { error: "DIRECTOR_CREATE_FAILED", why: "its reason" },
    { error: null, why: "no reason" },
  ])(
    "says Director couldn't write them ($why), and offers to describe it again",
    async ({ error }) => {
      await signUp();
      const videoId = newVideoId();
      await commands.fakeDirector(videoId, {
        plan: { source: "created", status: "failed", stage: "failed", error, plan: null },
      });
      const page = await open(videoId);
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent(
          "Director couldn't write your shots this time. Try describing it again.",
        );
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
    const page = await open(newVideoId());
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This Short isn't in your library yet.");
    expect(page.getByText("Nothing was used up. Try describing it again.").query()).toBeNull();
    await expect.element(page.getByRole("link", { name: "Describe it again" })).toBeVisible();
  });
});

describe("rearranging a described template's shots", () => {
  it("shows each card drawn or still drawing, and moves, rewords and adds shots", async () => {
    const { videoId, page } = await readyCreated();
    await expect.element(page.getByRole("heading", { name: "Cosy morning" })).toBeVisible();
    await expect.element(page.getByText("Coffee by the window.")).toBeVisible();
    await expect
      .element(page.getByRole("img", { name: "Storyboard for shot 1" }))
      .toHaveAttribute("src", expect.stringContaining("shot-0123456789abcdef.png"));
    // The second card isn't drawn yet, and says so.
    expect(page.getByRole("img", { name: "Storyboard for shot 2" }).query()).toBeNull();
    await expect.element(page.getByText("Drawing…")).toBeVisible();
    // The first shot can't move up, the last can't move down.
    await expect.element(page.getByRole("button", { name: "Move shot 1 up" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Move shot 2 down" })).toBeDisabled();

    const seconds = page.getByLabelText("Seconds");
    await userEvent.click(page.getByRole("button", { name: "Move shot 2 up" }));
    // Each card shows the shot it now holds, its length too.
    await expect.element(page.getByLabelText("What happens").first()).toHaveValue("First sip");
    await expect.element(seconds.first()).toHaveValue(3);
    await expect.element(seconds.last()).toHaveValue(2);
    await expect.poll(() => savedTitles(videoId)).toEqual(["First sip", "Pour the coffee"]);
    await userEvent.click(page.getByRole("button", { name: "Move shot 1 down" }));
    await expect.poll(() => savedTitles(videoId)).toEqual(["Pour the coffee", "First sip"]);

    await userEvent.fill(page.getByLabelText("Where").first(), "By the kettle");
    await userEvent.click(page.getByRole("button", { name: "Add a shot" }));
    await expect.element(page.getByLabelText("What happens").nth(2)).toHaveValue("A new shot");
    await expect
      .element(page.getByLabelText("Where").nth(2))
      .toHaveValue("Anywhere with good light");
    await expect
      .poll(async () =>
        (await api.director.plan({ videoId })).plan?.shots.map((shot) => shot.scene),
      )
      .toEqual(["By the kettle", expect.any(String), "Anywhere with good light"]);
  });

  it("adds no shot past the most a plan may have", async () => {
    const { page } = await readyCreated(
      Array.from({ length: 12 }, (_, at) => planShot({ title: `Shot ${at + 1}` })),
    );
    await expect.element(page.getByRole("button", { name: "Delete shot 12" })).toBeVisible();
    expect(page.getByRole("button", { name: "Add a shot" }).query()).toBeNull();
  });
});

describe("saving a described template's shots", () => {
  it("says why a change wasn't saved, keeps it, and doesn't send it again by itself", async () => {
    const { videoId, page } = await readyCreated();
    await commands.failRequests("/rpc/director/editPlan");
    const title = page.getByLabelText("What happens").first();
    await userEvent.fill(title, "Pour it slowly");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");
    await expect.element(title).toHaveValue("Pour it slowly");
    // Refused once: it waits for the member's next change rather than trying again.
    expect(await commands.failedRequests("/rpc/director/editPlan")).toBe(1);
    await expect
      .element(page.getByRole("button", { name: "Looks good, let's shoot" }))
      .toBeDisabled();
    expect(await savedTitles(videoId)).toEqual(["Pour the coffee", "First sip"]);
  });

  it("keeps a change made while the one before it was being saved, and saves it in turn", async () => {
    const { videoId, page } = await readyCreated();
    await commands.holdRequests("/rpc/director/editPlan");
    const title = page.getByLabelText("What happens").first();
    await userEvent.fill(title, "Grind the beans");
    await expect.poll(() => commands.sentHeaders("/rpc/director/editPlan")).toHaveLength(1);
    // The first save is on its way: this change comes after it.
    await userEvent.fill(title, "Grind the beans finely");
    await commands.releaseRequests("/rpc/director/editPlan");
    await expect.poll(() => savedTitles(videoId)).toEqual(["Grind the beans finely", "First sip"]);
    await expect.element(title).toHaveValue("Grind the beans finely");
    await expect.element(page.getByText("Saved", { exact: true })).toBeVisible();
  });
});
