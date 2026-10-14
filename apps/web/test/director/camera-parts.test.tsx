/**
 * The camera screen's parts: the HUD (the Live pill, the shot dots, the timer, the voice,
 * the take's status, the ready check), the dock and its shutter, Director's caption, the
 * countdown, and the teleprompter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { DirectorCaption } from "@/modules/director/components/live-caption";
import { LiveDock, Shutter } from "@/modules/director/components/live-dock";
import {
  LivePill,
  ReadyCheck,
  ShotDots,
  StatusPill,
  TimerButton,
  VoiceButton,
} from "@/modules/director/components/live-hud";
import {
  CountdownPulse,
  LiveBackdrop,
  LiveViewport,
} from "@/modules/director/components/live-stage";
import { Teleprompter } from "@/modules/director/components/teleprompter";
import { cleanup, renderPage } from "../render";
import { cameraStream } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Live pill", () => {
  it("breathes Live, with the voice bars dancing while someone talks", async () => {
    const page = await renderPage(<LivePill mode="live" talking seconds={0} onDevice={false} />);
    await expect.element(page.getByText("Live")).toBeInTheDocument();
    expect(document.querySelectorAll(".h-full")).toHaveLength(4);
  });

  it("says Paused, and when Director is guiding on the device", async () => {
    const page = await renderPage(<LivePill mode="paused" talking={false} seconds={0} onDevice />);
    await expect.element(page.getByText("Paused")).toBeInTheDocument();
    await expect.element(page.getByText("On-device")).toBeInTheDocument();
  });

  it("runs the take's clock while recording", async () => {
    const page = await renderPage(
      <LivePill mode="recording" talking={false} seconds={63.4} onDevice={false} />,
    );
    await expect.element(page.getByText("01:03")).toBeInTheDocument();
  });
});

describe("the HUD", () => {
  it("marks the shots done, this one and those to come", async () => {
    const page = await renderPage(<ShotDots index={1} count={3} />);
    await expect.element(page.getByRole("img", { name: "Shot 2 of 3" })).toBeInTheDocument();
  });

  it("cycles the countdown through Auto, 3, 5 and 10 seconds", async () => {
    const chosen = vi.fn();
    const auto = await renderPage(<TimerButton chosen={null} seconds={5} onChoose={chosen} />);
    await expect.element(auto.getByText("Auto 5s")).toBeInTheDocument();
    await userEvent.click(auto.getByRole("button", { name: "Countdown: 5 seconds" }));
    expect(chosen).toHaveBeenLastCalledWith(3);
    await cleanup();
    const ten = await renderPage(<TimerButton chosen={10} seconds={10} onChoose={chosen} />);
    await expect.element(ten.getByText("10s")).toBeInTheDocument();
    await userEvent.click(ten.getByRole("button"));
    expect(chosen).toHaveBeenLastCalledWith(null);
  });

  it("switches Director's voice on and off", async () => {
    const toggle = vi.fn();
    const on = await renderPage(<VoiceButton on onToggle={toggle} />);
    await expect
      .element(on.getByRole("button", { name: "Director's voice" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(on.getByRole("button"));
    expect(toggle).toHaveBeenCalledOnce();
    await cleanup();
    const off = await renderPage(<VoiceButton on={false} onToggle={toggle} />);
    await expect.element(off.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("names the take and the shot's size", async () => {
    const page = await renderPage(<StatusPill take={2} size="medium" />);
    await expect.element(page.getByText("Take 2 • Medium shot")).toBeInTheDocument();
  });

  it("lights each check that's fine, leaves out what can't be judged, and goes green when all are", async () => {
    const some = await renderPage(
      <ReadyCheck readiness={{ spot: "ok", frame: "off", angle: "na", light: "ok" }} />,
    );
    await expect.element(some.getByRole("img", { name: "2 of 3 ready" })).toBeInTheDocument();
    await cleanup();
    const all = await renderPage(
      <ReadyCheck readiness={{ spot: "ok", frame: "ok", angle: "na", light: "na" }} />,
    );
    await expect.element(all.getByRole("img", { name: "2 of 2 ready" })).toHaveClass("bg-guide/25");
    await cleanup();
    const none = await renderPage(
      <ReadyCheck readiness={{ spot: "na", frame: "na", angle: "na", light: "na" }} />,
    );
    expect(none.getByRole("img").query()).toBeNull();
  });
});

describe("the dock", () => {
  const dock = (overrides: Partial<Parameters<typeof LiveDock>[0]> = {}) => ({
    idle: false,
    shutter: <span>shutter</span>,
    sharing: false,
    onShare: vi.fn(),
    listen: "off" as const,
    onListen: vi.fn(),
    paused: false,
    onPause: vi.fn(),
    endHref: "/director/abc" as const,
    ...overrides,
  });

  it("shares the screen, talks, pauses and ends", async () => {
    const onShare = vi.fn();
    const onListen = vi.fn();
    const onPause = vi.fn();
    const page = await renderPage(<LiveDock {...dock({ onShare, onListen, onPause })} />);
    await userEvent.click(page.getByRole("button", { name: "Show Director your screen" }));
    await userEvent.click(page.getByRole("button", { name: "Talk to Director" }));
    await userEvent.click(page.getByRole("button", { name: "Pause Director" }));
    expect([onShare, onListen, onPause].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
    await expect
      .element(page.getByRole("link", { name: "End the session" }))
      .toHaveAttribute("href", "/director/abc");
  });

  it("says what each button does now: stop sharing, stop listening, resume", async () => {
    const page = await renderPage(
      <LiveDock {...dock({ sharing: true, listen: "listening", paused: true })} />,
    );
    await expect
      .element(page.getByRole("button", { name: "Back to the camera" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Stop listening" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("button", { name: "Resume Director" })).toBeInTheDocument();
  });

  it("says why it can't listen, and leaves out sharing where the browser can't", async () => {
    const unsupported = await renderPage(
      <LiveDock {...dock({ onShare: null, listen: "unsupported" })} />,
    );
    await expect
      .element(unsupported.getByRole("button", { name: /can't hear you/ }))
      .toBeDisabled();
    expect(
      unsupported.getByRole("button", { name: "Show Director your screen" }).query(),
    ).toBeNull();
    await cleanup();
    const blocked = await renderPage(<LiveDock {...dock({ listen: "blocked" })} />);
    await expect
      .element(blocked.getByRole("button", { name: /Allow the microphone/ }))
      .toBeInTheDocument();
  });

  it("steps back when left alone, all but the shutter", async () => {
    const page = await renderPage(<LiveDock {...dock({ idle: true })} />);
    await expect.element(page.getByText("shutter")).toBeVisible();
    expect(
      page.getByRole("button", { name: "Pause Director" }).element().closest(".opacity-0"),
    ).not.toBeNull();
  });
});

describe("the shutter", () => {
  it("records, shoots a photo, or stops with the take's progress round it", async () => {
    const press = vi.fn();
    const record = await renderPage(
      <Shutter mode="record" label="Record" progress={0} disabled={false} onClick={press} />,
    );
    await userEvent.click(record.getByRole("button", { name: "Record" }));
    expect(press).toHaveBeenCalledOnce();
    await cleanup();
    const photo = await renderPage(
      <Shutter mode="photo" label="Take the photo" progress={0} disabled onClick={press} />,
    );
    await expect.element(photo.getByRole("button")).toBeDisabled();
    await cleanup();
    await renderPage(
      <Shutter mode="stop" label="Stop" progress={2} disabled={false} onClick={press} />,
    );
    // Full at most, however far past the shot the take runs.
    expect(document.querySelectorAll("circle")[1]?.getAttribute("stroke-dashoffset")).toBe("0");
  });
});

describe("Director's caption", () => {
  it("shows what Director said and what it heard", async () => {
    const page = await renderPage(
      <DirectorCaption
        line={{ text: "Great spot!", mood: "cheer", key: 1 }}
        talking
        heard="action"
        listening
      />,
    );
    await expect.element(page.getByText("Great spot!")).toBeInTheDocument();
    await expect.element(page.getByText("action")).toBeInTheDocument();
  });

  it("shows nothing with nothing said or heard, and no words while not listening", async () => {
    await renderPage(<DirectorCaption line={null} talking={false} heard="" listening={false} />);
    expect(document.querySelector("div[aria-live=polite]")).toBeNull();
    await cleanup();
    const quiet = await renderPage(
      <DirectorCaption
        line={{ text: "Step back", mood: "warn", key: 2 }}
        talking={false}
        heard="hello"
        listening={false}
      />,
    );
    expect(quiet.getByText("hello").query()).toBeNull();
    await cleanup();
    const heardOnly = await renderPage(
      <DirectorCaption line={null} talking={false} heard="cut" listening />,
    );
    await expect.element(heardOnly.getByText("cut")).toBeInTheDocument();
  });
});

describe("the stage", () => {
  it("counts down in big numbers, and shows nothing between counts", async () => {
    const page = await renderPage(<CountdownPulse seconds={3} />);
    await expect.element(page.getByText("3")).toBeInTheDocument();
    await cleanup();
    await renderPage(<CountdownPulse seconds={null} />);
    expect(document.querySelector("[aria-live=assertive]")).toBeNull();
  });

  it("floats the camera over a blurred copy of itself, glowing while Director talks, flashing on the beat", async () => {
    const stream = cameraStream();
    await renderPage(
      <>
        <LiveBackdrop stream={stream} />
        <LiveViewport glowing recording={false} beat={2}>
          <p>picture</p>
        </LiveViewport>
      </>,
    );
    await expect.poll(() => document.querySelector("video")?.srcObject).toBe(stream);
    expect(document.querySelector(".opacity-90")).not.toBeNull();
    expect(document.querySelector("[class*='live-beat']")).not.toBeNull();
    await cleanup();
    await renderPage(
      <LiveViewport glowing={false} recording beat={0}>
        <p>picture</p>
      </LiveViewport>,
    );
    expect(document.querySelector(".ring-record")).not.toBeNull();
    expect(document.querySelector("[class*='live-beat']")).toBeNull();
  });
});

const script = [
  { startSeconds: 0, endSeconds: 1, text: "Morning." },
  { startSeconds: 1, endSeconds: 3, text: "Coffee first." },
  { startSeconds: 3, endSeconds: 4, text: "Then the window." },
];

describe("the teleprompter", () => {
  it("lights the line to say now, swept as it's said, fading the ones said", async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const page = await renderPage(<Teleprompter script={script} seconds={1.5} />);
    const lines = page.getByRole("region", { name: "Teleprompter" }).getByRole("listitem");
    await expect.element(lines.nth(1)).toHaveAttribute("aria-current", "true");
    await expect.element(lines.nth(0)).toHaveClass("opacity-30");
    await expect.element(lines.nth(2)).toHaveClass("opacity-60");
    const sweep = lines.nth(1).element().querySelector("span");
    expect(sweep?.style.backgroundPosition).toBe("75% 0px");
    expect(scrolled.mock.contexts[0]).toBe(lines.nth(1).element());
  });

  it("leaves every line waiting once they're all said", async () => {
    const page = await renderPage(<Teleprompter script={script} seconds={9} />);
    const lines = page.getByRole("listitem");
    await expect.element(lines.nth(0)).toHaveClass("opacity-60");
    expect(document.querySelector("[aria-current]")).toBeNull();
  });

  it("shows nothing for a shot without lines", async () => {
    const page = await renderPage(<Teleprompter script={[]} seconds={0} />);
    expect(page.getByRole("region", { name: "Teleprompter" }).query()).toBeNull();
  });
});
