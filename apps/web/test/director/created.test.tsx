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
