/**
 * The editor's parts as a screen reader and a keyboard meet them: the gap tiles say what
 * they show, the "tell Director" bar's controls are each their own, and the picker's
 * clips stay still until the member looks at one.
 */
import type { ServedShotPlan } from "@repo/contracts/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { PictureTile } from "@/modules/director/components/asset-picker";
import { GapStrip } from "@/modules/director/components/gap-strip";
import { TellDirector } from "@/modules/director/components/tell-director";
import { renderPage } from "../render";
import { recordVideo } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the gap tiles", () => {
  it("are named by what they show: the time, the moment and whether it's filled", async () => {
    // The plan is only read once a tile opens the picker.
    const plan = {} as ServedShotPlan;
    const page = await renderPage(
      <GapStrip
        videoId="abcdefghijk"
        plan={plan}
        gaps={[
          {
            slotId: "gap-1",
            description: "Steam over the cup",
            span: { start: 3, end: 4 },
            shotIndex: 2,
          },
        ]}
        slots={[]}
        locked={false}
      />,
    );
    await expect
      .element(
        page.getByRole("button", {
          name: "00:03 Steam over the cup Skipped shot Holds your shot",
          exact: true,
        }),
      )
      .toBeVisible();
  });
});

describe("the tell Director bar", () => {
  it("keeps Send apart from the box it sends, each with its own name", async () => {
    const onSend = vi.fn();
    const page = await renderPage(
      <TellDirector
        reply={null}
        pending={false}
        error={null}
        shots={[]}
        media={new Map()}
        onSend={onSend}
        onListen={() => undefined}
        onPick={() => undefined}
        onUndo={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    const box = page.getByRole("textbox", { name: "Tell Director what to change" });
    const send = page.getByRole("button", { name: "Send" });
    // A button inside the box's label would be part of what the label names.
    expect(send.element().closest("label")).toBeNull();
    await userEvent.fill(box, "warmer please");
    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledWith({ text: "warmer please" });
    await expect.element(box).toHaveValue("");
    // Nothing but spaces isn't a request, even sent past the disabled Send (a script, an
    // assistive tool).
    await userEvent.fill(box, "   ");
    box.element().closest("form")?.requestSubmit();
    expect(onSend).toHaveBeenCalledOnce();
  });
});

describe("the picker's clips", () => {
  it("stay still until hovered or focused, and stop again after", async () => {
    const url = URL.createObjectURL(await recordVideo(1));
    const page = await renderPage(
      <PictureTile
        label="A clip"
        image={{ status: "ready", url, media: "video" }}
        selected={false}
        inUse={false}
        onSelect={() => undefined}
      />,
    );
    const tile = page.getByRole("button", { name: "A clip" });
    const video = tile.element().querySelector("video");
    if (!video) {
      throw new Error("the tile shows no clip");
    }
    expect(video.autoplay).toBe(false);
    expect(video.paused).toBe(true);
    await userEvent.hover(tile);
    await expect.poll(() => video.paused).toBe(false);
    await userEvent.unhover(tile);
    await expect.poll(() => video.paused).toBe(true);
    const button = tile.element();
    if (button instanceof HTMLElement) {
      button.focus();
    }
    await expect.poll(() => video.paused).toBe(false);
    if (button instanceof HTMLElement) {
      button.blur();
    }
    await expect.poll(() => video.paused).toBe(true);
    URL.revokeObjectURL(url);
  });
});
