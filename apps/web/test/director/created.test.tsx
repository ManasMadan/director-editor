/** A template the member described: its shots, changed and saved as they're changed. */
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { CreatedPage } from "@/modules/director";
import { cleanup, renderPage } from "../render";
import { api, signUp } from "../users";
import { newVideoId, planShot, readyPlan, shotPlan } from "./support";

async function described() {
  await signUp();
  const videoId = newVideoId();
  await readyPlan(
    videoId,
    shotPlan({
      shots: [planShot({ title: "Pour the coffee" }), planShot({ title: "First sip" })],
    }),
  );
  const page = await renderPage(<CreatedPage videoId={videoId} />, { url: `/create/${videoId}` });
  return { videoId, page };
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
