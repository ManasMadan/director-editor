/**
 * The roll's pieces on their own: what the shoot screen says about the footage it's
 * uploading, the wait after Done, and the paused veil's Space key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
  PausedVeil,
  RecIndicator,
  RollProgress,
  SavingFootage,
  UploadNotice,
} from "@/modules/director/components/roll-parts";
import { cleanup, currentUrl, renderPage } from "../render";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the upload notice", () => {
  it("says nothing while the footage keeps up", async () => {
    const page = await renderPage(<UploadNotice lost={null} waiting={false} nearLimit={false} />);
    expect(page.getByRole("status").query()).toBeNull();
    expect(page.getByRole("alert").query()).toBeNull();
  });

  it("says the footage is waiting, and that the shoot's time is nearly up", async () => {
    const page = await renderPage(<UploadNotice lost={null} waiting nearLimit />);
    await expect
      .element(page.getByText("Your footage is waiting to upload.", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByText("About three minutes of recording left in this shoot."))
      .toBeVisible();
  });

  it("says what was lost and why, ahead of anything waiting", async () => {
    const page = await renderPage(
      <UploadNotice lost="That's the 20 minutes a shoot can record." waiting nearLimit={false} />,
    );
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("That's the 20 minutes a shoot can record.");
    expect(page.getByText("Your footage is waiting", { exact: false }).query()).toBeNull();
  });
});

describe("saving the footage after Done", () => {
  it("says how much is left, and opens the editor while it keeps uploading", async () => {
    const page = await renderPage(
      <SavingFootage behindMs={12_400} waiting={false} editor="/director/abcdefghijk/edit" />,
    );
    await expect.element(page.getByText("Saving your footage, 13 seconds to go…")).toBeVisible();
    await userEvent.click(page.getByRole("link", { name: "Open the editor now", exact: false }));
    await expect.poll(currentUrl).toBe("/director/abcdefghijk/edit");
  });

  it("says when it's waiting for a connection", async () => {
    const page = await renderPage(
      <SavingFootage behindMs={0} waiting editor="/director/abcdefghijk/edit" />,
    );
    await expect.element(page.getByText("Saving your footage…")).toBeVisible();
    await expect
      .element(page.getByText("Your footage is waiting to upload.", { exact: false }))
      .toBeVisible();
  });
});

describe("the paused veil", () => {
  it("resumes on Space, but not when Space presses a button or answers a dialog", async () => {
    const onResume = vi.fn();
    const page = await renderPage(
      <>
        <PausedVeil onResume={onResume} />
        <button type="button">Elsewhere</button>
        <div role="alertdialog" aria-label="Leave?">
          <button type="button">Stay</button>
        </div>
        <input aria-label="Say something" />
      </>,
    );
    // The veil covers the screen: keyboard focus reaches what's under it all the same.
    for (const target of [
      page.getByRole("button", { name: "Elsewhere" }),
      page.getByRole("button", { name: "Stay" }),
      page.getByRole("textbox", { name: "Say something" }),
    ]) {
      const element = target.element();
      if (element instanceof HTMLElement) {
        element.focus();
      }
      await userEvent.keyboard(" ");
    }
    expect(onResume).not.toHaveBeenCalled();
    // Space anywhere else resumes, as the Resume button does.
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard(" ");
    expect(onResume).toHaveBeenCalledTimes(1);
    await userEvent.click(page.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledTimes(2);
    // Space sent to the window itself (no element has it), and any other key.
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR" }));
    expect(onResume).toHaveBeenCalledTimes(3);
  });
});

describe("the roll's indicator", () => {
  it("shows the time recorded with pause, and says paused with Resume", async () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const recording = await renderPage(
      <RecIndicator elapsedMs={192_000} paused={false} onPause={onPause} onResume={onResume} />,
    );
    await expect.element(recording.getByRole("status", { name: "Recording, 03:12" })).toBeVisible();
    await userEvent.click(recording.getByRole("button", { name: "Pause recording" }));
    expect(onPause).toHaveBeenCalledOnce();
    cleanup();
    const paused = await renderPage(
      <RecIndicator elapsedMs={192_000} paused onPause={onPause} onResume={onResume} />,
    );
    await expect.element(paused.getByRole("status", { name: "Paused" })).toBeVisible();
    await userEvent.click(paused.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledOnce();
  });
});

describe("the progress strip", () => {
  it("marks each shot, lights the one on screen, and goes to the one tapped", async () => {
    const onGo = vi.fn();
    const page = await renderPage(
      <RollProgress index={1} states={["take", "tried", "todo"]} onGo={onGo} />,
    );
    await expect
      .element(page.getByRole("button", { name: "Shot 2: attempted. Go there" }))
      .toHaveAttribute("aria-current", "step");
    expect(
      page.getByRole("button", { name: "Shot 1: has a take. Go there" }).element(),
    ).not.toHaveAttribute("aria-current");
    await userEvent.click(page.getByRole("button", { name: "Shot 3: to do. Go there" }));
    expect(onGo).toHaveBeenCalledWith(2);
  });
});
