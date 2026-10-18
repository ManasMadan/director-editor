/**
 * The shoot screen, against the real API with Director live on: the API's relay talks to
 * the mock Google's Live API (packages/fake-google), which answers each turn and calls a
 * tool on its cue ("go to shot 2", "switch to the back camera"). The camera and the
 * microphone are a canvas and a tone; the recorder, the audio, the socket and the API are
 * the browser's and the app's own.
 */
import { useSearchParams } from "next/navigation";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ShootPage } from "@/modules/director";
import { currentUrl, renderPage } from "../render";
import { signUp, type User } from "../users";
import {
  canvasCamera,
  FakeRecognizer,
  fakeRecognizer,
  newVideoId,
  planShot,
  readyPlan,
  shotPlan,
} from "./support";

type Page = Awaited<ReturnType<typeof renderPage>>;

/** A line in the captions, as the eye reads it (screen readers hear "Director says …"). */
const line = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

let liveFrom = 0;
beforeEach(async () => {
  fakeRecognizer();
  window.localStorage.clear();
  liveFrom = await commands.liveSessionCount();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const walkIn = planShot({
  title: "Walk in",
  durationSeconds: 3,
  steps: [{ atSeconds: 0, instruction: "Walk towards the camera.", cameraMove: "static" }],
  script: [
    { startSeconds: 0, endSeconds: 0.6, text: "Morning." },
    { startSeconds: 0.6, endSeconds: 3, text: "Coffee first." },
  ],
});
const smile = planShot({ kind: "photo", title: "Smile", durationSeconds: 1, scene: "Kitchen" });

/**
 * The shoot route as Next serves it: the page reads the shot from the address, and stays
 * mounted (its camera and Director with it) when only the query changes.
 */
function ShootRoute({ videoId }: { videoId: string }) {
  const query = useSearchParams();
  return (
    <ShootPage
      videoId={videoId}
      shot={query.get("shot") ?? undefined}
      audio={query.get("audio") ?? undefined}
      back={query.get("back") ?? undefined}
    />
  );
}

async function openShoot(
  plan: Parameters<typeof shotPlan>[0],
  query = "shot=0&audio=voice",
): Promise<{ page: Page; videoId: string; user: User }> {
  const videoId = newVideoId();
  await readyPlan(videoId, shotPlan(plan));
  const user = await signUp();
  const page = await renderPage(<ShootRoute videoId={videoId} />, {
    url: `/director/${videoId}/shoot?${query}`,
  });
  return { page, videoId, user };
}

/** Taps Start shooting, and waits for Director's hello. */
async function startShooting(page: Page) {
  await userEvent.click(page.getByRole("button", { name: "Start shooting" }));
  await expect
    .element(page.getByText(line("Hey! I'm Director. How much time have you got?")), {
      timeout: 15_000,
    })
    .toBeVisible();
}

/** What the mock Live API was told on this test's connections, every turn in order. */
async function turns() {
  return (await commands.liveTurns(liveFrom)).flatMap((session) => session.turns);
}

/** Types a line to Director. */
async function send(page: Page, text: string) {
  await userEvent.fill(page.getByRole("textbox", { name: "Tell Director" }), text);
  await userEvent.click(page.getByRole("button", { name: "Send" }));
}

/** Types a line to Director, and waits for its answer. */
async function tell(page: Page, text: string, answer: string) {
  await send(page, text);
  await expect.element(page.getByText(line(answer)).last()).toBeVisible();
}

/** The cameras opened so far: "user" for the selfie side, "environment" for the back. */
function facings(camera: ReturnType<typeof canvasCamera>) {
  return camera.opened.flatMap(({ video }) =>
    typeof video === "object" && typeof video.facingMode === "string" ? [video.facingMode] : [],
  );
}

describe("before the plan is ready", () => {
  it("says Director is still at work, and leads back", async () => {
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, { plan: { status: "analyzing", plan: null } });
    await signUp();
    const page = await renderPage(<ShootPage videoId={videoId} shot="0" audio="voice" />, {
      url: `/director/${videoId}/shoot`,
    });
    await expect.element(page.getByText("Director is getting ready…")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Back" }))
      .toHaveAttribute("href", `/director/${videoId}`);
  });
});

describe("starting to shoot", () => {
  it("explains first, and opens nothing until Start shooting", async () => {
    const camera = canvasCamera();
    const { page, user } = await openShoot({ shots: [walkIn, smile] });
    await expect
      .element(page.getByRole("heading", { name: "Let's shoot this together" }))
      .toBeVisible();
    await expect
      .element(page.getByText(/Your browser asks for the camera and microphone next\./))
      .toBeVisible();
    expect(camera.getUserMedia).not.toHaveBeenCalled();
    expect(await turns()).toEqual([]);
    await startShooting(page);
    // The selfie camera first, with the microphone for the take; and one for Director.
    expect(facings(camera)).toEqual(["user"]);
    // Next time, it's shorter.
    const memory = JSON.parse(window.localStorage.getItem(`director.memory.${user.id}`) ?? "{}");
    expect(memory).toEqual({ version: 1, sessions: 1 });
  });

  it("says less the second time", async () => {
    canvasCamera();
    const videoId = newVideoId();
    await readyPlan(videoId, shotPlan({ shots: [walkIn] }));
    const user = await signUp();
    window.localStorage.setItem(
      `director.memory.${user.id}`,
      JSON.stringify({ version: 1, sessions: 3 }),
    );
    const page = await renderPage(<ShootRoute videoId={videoId} />, {
      url: `/director/${videoId}/shoot?shot=0&audio=voice`,
    });
    await expect
      .element(
        page.getByText(
          "Director sees and hears you while you get set. A take records only when you tap the shutter.",
        ),
      )
      .toBeVisible();
  });

  it("asks for the camera again after it was refused, or says there's none", async () => {
    const camera = canvasCamera(new DOMException("denied", "NotAllowedError"));
    const { page } = await openShoot({ shots: [walkIn] });
    await userEvent.click(page.getByRole("button", { name: "Start shooting" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Director needs your camera. Allow it in your browser's settings, then try again.",
      );
    camera.getUserMedia.mockRejectedValue(new DOMException("none", "NotFoundError"));
    await userEvent.click(page.getByRole("button", { name: "Try again" }).first());
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("There's no camera Director can use on this device.");
  });

  it("starts at the first shot for a shot it can't read", async () => {
    canvasCamera();
    const first = await openShoot({ shots: [walkIn, smile] }, "shot=next&audio=voice");
    await startShooting(first.page);
    await expect.element(first.page.getByRole("img", { name: "Shot 1 of 2" })).toBeVisible();
  });

  it("opens the last shot when asked for one past the end", async () => {
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] }, "shot=7");
    await startShooting(page);
    await expect.element(page.getByRole("img", { name: "Shot 2 of 2" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Take the photo" })).toBeVisible();
  });
});

describe("a shoot with Director", () => {
  it("never starts a take from anything said: only the shutter starts one", async () => {
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    // No speech recogniser listens for command words any more.
    expect(FakeRecognizer.last).toBeNull();
    for (const line of ["okay let me go to the kitchen", "go", "ready", "let's go", "start"]) {
      await tell(page, line, `You said: ${line}`);
      await expect.element(page.getByRole("button", { name: "Record a take" })).toBeVisible();
      expect(page.getByText("REC").query()).toBeNull();
    }
    // Every line reached Director as the member's own words.
    expect(await turns()).toEqual(
      expect.arrayContaining(["okay let me go to the kitchen", "go", "ready", "let's go", "start"]),
    );
    expect((await turns()).some((turn) => turn.includes("take of shot 1 is recording"))).toBe(
      false,
    );
  });

  it("puts only flip, the shutter and the text box in the member's hands", async () => {
    canvasCamera();
    const { page, videoId } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    const buttons = page.getByRole("button").elements();
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Send",
      "Flip the camera",
      "Record a take",
    ]);
    await expect.element(page.getByRole("textbox", { name: "Tell Director" })).toBeVisible();
    // And the way out.
    await expect
      .element(page.getByRole("link", { name: "Leave the shoot" }))
      .toHaveAttribute("href", `/director/${videoId}`);
    // The shot card says what to do.
    await expect.element(page.getByRole("heading", { name: "Shot 1 · Walk in" })).toBeVisible();
    await expect.element(page.getByText("“Morning. Coffee first.”")).toBeVisible();
  });

  it("tells Director about a flip, and Director talks about the new view", async () => {
    const camera = canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Flip the camera" }));
    await expect
      .element(page.getByText(line("Ooh, the back camera! Now I can see the room.")))
      .toBeVisible();
    expect(facings(camera)).toEqual(["user", "environment"]);
    expect(await turns()).toContainEqual(
      expect.stringContaining("[They flipped to the back camera."),
    );
  });

  it("moves between shots when Director does, with the same camera and the same Director", async () => {
    const camera = canvasCamera();
    const { page, videoId } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    const opened = camera.getUserMedia.mock.calls.length;
    await send(page, "can we go to shot 2");
    await expect.poll(currentUrl).toBe(`/director/${videoId}/shoot?shot=1&audio=voice`);
    await expect.element(page.getByRole("img", { name: "Shot 2 of 2" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Shot 2 · Smile" })).toBeVisible();
    // Director hears it worked, and is told about the shot it's on now.
    await expect
      .poll(turns)
      .toContainEqual(expect.stringContaining("[They've moved on to shot 2."));
    // Nothing reopened: no black flash between shots, and no second hello.
    expect(camera.getUserMedia.mock.calls.length).toBe(opened);
    const sessions = await commands.liveTurns(liveFrom);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.toolResponses).toEqual([{ result: "done" }]);
    // Director flips the camera when asked; it doesn't tell itself about it.
    await send(page, "switch to the back camera please");
    await expect.poll(() => facings(camera)).toEqual(["user", "environment"]);
    await expect
      .poll(async () => (await commands.liveTurns(liveFrom))[0]?.toolResponses)
      .toEqual([{ result: "done" }, { result: "done" }]);
    expect((await turns()).some((turn) => turn.includes("They flipped"))).toBe(false);
  });

  it("calls off the countdown from the shutter or Escape, and records only once it ends", async () => {
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await expect.element(page.getByText("3", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel the countdown" }));
    await expect.element(page.getByRole("button", { name: "Record a take" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await expect.element(page.getByRole("button", { name: "Cancel the countdown" })).toBeVisible();
    // Only Escape calls it off from the keyboard.
    await userEvent.keyboard("x");
    await expect.element(page.getByRole("button", { name: "Cancel the countdown" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Record a take" })).toBeVisible();
    expect(page.getByText("REC").query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await expect
      .element(page.getByRole("status").getByText("REC"), { timeout: 6_000 })
      .toBeVisible();
  });

  it("keeps Director quiet through a take, and has it speak first once it ends", async () => {
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await expect.element(page.getByText("REC"), { timeout: 6_000 }).toBeVisible();
    await expect.element(page.getByText("Director's quiet while you film")).toBeVisible();
    // The line stays near the lens; the text box steps aside.
    await expect.element(page.getByRole("region", { name: "Teleprompter" })).toBeVisible();
    expect(page.getByRole("textbox", { name: "Tell Director" }).query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Stop recording" }));
    await expect.element(page.getByLabelText("Your take, on loop")).toBeVisible();
    await expect
      .element(page.getByText(line("Nice one! Maybe hold the last moment a beat longer.")))
      .toBeVisible();
    // The text box is there on the review too, to answer Director without a microphone.
    await tell(page, "was the light ok?", "You said: was the light ok?");
    await userEvent.click(page.getByRole("button", { name: "Go again" }));
    await expect.element(page.getByRole("button", { name: "Record a take" })).toBeVisible();
    await expect
      .poll(turns)
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining("[They're counting in to a take of shot 1. Go quiet now"),
          expect.stringContaining("[A take of shot 1 is recording now."),
          expect.stringContaining("[The take just ended"),
          "[They're going again on shot 1.]",
        ]),
      );
  });
});

describe("talking it through with Director", () => {
  it("answers a typed line at once, and reads the member's line when asked", async () => {
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    // Through the relay and back: the app's own part of the time to an answer.
    const sent = performance.now();
    await tell(page, "ok I'm going", "You said: ok I'm going");
    expect(performance.now() - sent).toBeLessThan(1500);
    await tell(page, "can you say my line again?", `It's: "Morning. Coffee first."`);
  });

  it("puts the member's twist on the card, says so, and keeps it for the shoot", async () => {
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    await send(page, "what if I do this one with my grandma instead?");
    await expect
      .element(page.getByText(line("Ooh, I love that. Let's put it on your card.")))
      .toBeVisible();
    const card = page.getByRole("region", { name: "Shot 1" });
    await expect.element(card.getByText("You and your grandma do it together")).toBeVisible();
    await expect.element(card.getByText("changed for you")).toBeVisible();
    // Only the row that changed says so.
    expect(card.getByText("changed for you").elements()).toHaveLength(1);
    await expect.element(page.getByText(line("There you go."))).toBeVisible();
    expect((await commands.liveTurns(liveFrom))[0]?.toolResponses).toEqual([{ result: "done" }]);
    // Their line is the original's still, and Director moves on and back with the change kept.
    await tell(page, "say my line", `It's: "Morning. Coffee first."`);
    await send(page, "go to shot 2");
    await expect.element(page.getByRole("heading", { name: "Shot 2 · Smile" })).toBeVisible();
    await send(page, "go to shot 1");
    await expect.element(card.getByText("You and your grandma do it together")).toBeVisible();
    await expect
      .poll(turns)
      .toContainEqual(
        expect.stringContaining('- What they do: "You and your grandma do it together"'),
      );
  });
});

describe("leaving the shoot", () => {
  it("leaves at once with nothing at stake", async () => {
    canvasCamera();
    const { page, videoId } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    // A back with nothing at stake isn't the guard's business.
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(page.getByRole("alertdialog").query()).toBeNull();
    await userEvent.click(page.getByRole("link", { name: "Leave the shoot" }));
    await expect.poll(currentUrl).toBe(`/director/${videoId}`);
  });

  it("asks first during a take, keeps the take on Stay, and leaves on Leave", async () => {
    canvasCamera();
    const { page, videoId } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await expect.element(page.getByText("REC"), { timeout: 6_000 }).toBeVisible();
    await userEvent.click(page.getByRole("link", { name: "Leave the shoot" }));
    const dialog = page.getByRole("alertdialog", { name: "Leave?" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("This take isn't kept yet.")).toBeVisible();
    // Focus starts on Stay: Enter doesn't leave by accident.
    await expect.element(dialog.getByRole("button", { name: "Stay" })).toHaveFocus();
    // The recording stopped at once: the take is safe behind the question.
    await userEvent.click(dialog.getByRole("button", { name: "Stay" }));
    await expect.element(page.getByLabelText("Your take, on loop")).toBeVisible();
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=0&audio=voice`);
    // The browser's back asks too, and asks again after Stay.
    window.history.back();
    await expect.element(page.getByRole("alertdialog", { name: "Leave?" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Stay" }));
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    window.history.back();
    await expect.element(page.getByRole("alertdialog", { name: "Leave?" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Leave" }));
    await expect.poll(currentUrl).toBe(`/director/${videoId}`);
  });

  it("calls off a countdown behind the question, and leaves at once once nothing's at stake", async () => {
    canvasCamera();
    const { page, videoId } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await userEvent.click(page.getByRole("link", { name: "Leave the shoot" }));
    await userEvent.click(page.getByRole("button", { name: "Stay" }));
    await expect.element(page.getByRole("button", { name: "Record a take" })).toBeVisible();
    expect(page.getByText("REC").query()).toBeNull();
    await userEvent.click(page.getByRole("link", { name: "Leave the shoot" }));
    await expect.poll(currentUrl).toBe(`/director/${videoId}`);
  });
});

describe("leaving the shoot, right after going again", () => {
  it("puts the new take's history entry on only once the old one's pop has landed", async () => {
    // What happens to history: the guard's own back, the pop it causes, and the new
    // take's entry. Listening before the page does, so the pop is logged before the
    // guard acts on it.
    const log: string[] = [];
    const popped = () => log.push("pop");
    window.addEventListener("popstate", popped);
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await userEvent.click(page.getByRole("button", { name: "Stop recording" }), {
      timeout: 6_000,
    });
    await expect.element(page.getByRole("button", { name: "Go again" })).toBeVisible();
    const push = window.history.pushState.bind(window.history);
    const back = window.history.back.bind(window.history);
    vi.spyOn(window.history, "pushState").mockImplementation((...args) => {
      log.push("push");
      push(...args);
    });
    vi.spyOn(window.history, "back").mockImplementation(() => {
      log.push("back");
      back();
    });
    log.length = 0;
    // Go again, and the shutter straight after in the same task, before the pop lands.
    const again = page.getByRole("button", { name: "Go again" }).element();
    flushSync(() => (again as HTMLButtonElement).click());
    (page.getByRole("button", { name: "Record a take" }).element() as HTMLButtonElement).click();
    await expect.element(page.getByRole("button", { name: "Cancel the countdown" })).toBeVisible();
    // Pushed before the pop, the entry would be popped with it, and back would leave
    // without asking; pushed after, it's there for back to pop and ask.
    await expect.poll(() => log).toEqual(["back", "pop", "push"]);
    window.removeEventListener("popstate", popped);
  });
});

describe("when Director can't join", () => {
  it("says so, and the shutter still works", async () => {
    canvasCamera();
    const system = await fetch("/rpc/system/info", { method: "POST" }).then(
      (response) => response.json() as Promise<{ json: { features: Record<string, boolean> } }>,
    );
    system.json.features.live = false;
    await commands.failRequests("/rpc/system/info", { status: 200, body: system });
    const { page } = await openShoot({ shots: [walkIn, smile] });
    await userEvent.click(page.getByRole("button", { name: "Start shooting" }));
    await expect.element(page.getByText("Director isn't available right now.")).toBeVisible();
    await expect
      .element(page.getByText("You can still film: tap the shutter for each take."))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Try again" }).query()).toBeNull();
    expect(page.getByRole("textbox", { name: "Tell Director" }).query()).toBeNull();
    await expect.element(page.getByRole("button", { name: "Record a take" })).toBeEnabled();
    expect(await turns()).toEqual([]);
    // Watching a take back, there's no one to type to either.
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await userEvent.click(page.getByRole("button", { name: "Stop recording" }), {
      timeout: 6_000,
    });
    await expect.element(page.getByLabelText("Your take, on loop")).toBeVisible();
    expect(page.getByRole("textbox", { name: "Tell Director" }).query()).toBeNull();
  });
});

describe("filming", () => {
  it("opens the first shot when the address names none", async () => {
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] }, "audio=voice");
    await startShooting(page);
    await expect.element(page.getByRole("img", { name: "Shot 1 of 2" })).toBeVisible();
  });

  it("plays the original's sound while a take films along to it", async () => {
    canvasCamera();
    const { page } = await openShoot(
      { audio: "music", shots: [walkIn, smile] },
      "shot=0&audio=original",
    );
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await expect
      .element(page.getByTitle("The original's audio plays while you film."), { timeout: 6_000 })
      .toBeInTheDocument();
  });

  it("says when this browser can't record, and goes back to getting ready", async () => {
    canvasCamera();
    vi.stubGlobal("MediaRecorder", undefined);
    const { page } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await expect
      .poll(() => page.getByRole("alert").query()?.textContent, { timeout: 6_000 })
      .toBe("Director couldn't start the camera's recording here. Try again, or another browser.");
    await expect.element(page.getByRole("button", { name: "Record a take" })).toBeEnabled();
  });
});

/** The take the page uploaded last, once storage has it. */
async function lastUpload(user: User) {
  await expect.poll(() => commands.answeredRequests("/rpc/files/completeUpload")).toBe(1);
  const [row] = await commands.sql<{ id: string }>(
    "SELECT id::text FROM files.file WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [user.id],
  );
  return row?.id as string;
}

// Takes are uploaded to RustFS: the files profile (`bun run test:integration:files`).
describe("sending a take", { tags: ["files"] }, () => {
  it("keeps the take and moves to the next shot, camera and Director still up", async () => {
    await commands.storageCors();
    const camera = canvasCamera();
    const { page, videoId, user } = await openShoot({ shots: [walkIn, smile] });
    await startShooting(page);
    const opened = camera.getUserMedia.mock.calls.length;
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await userEvent.click(page.getByRole("button", { name: "Stop recording" }), { timeout: 6_000 });
    await userEvent.click(page.getByRole("button", { name: /Keep it/ }));
    await commands.checkUpload(await lastUpload(user));
    await expect.poll(currentUrl).toBe(`/director/${videoId}/shoot?shot=1&audio=voice`);
    await expect.element(page.getByRole("button", { name: "Take the photo" })).toBeVisible();
    expect(camera.getUserMedia.mock.calls.length).toBe(opened);
    expect(await commands.liveTurns(liveFrom)).toHaveLength(1);
  });

  it("takes the last shot's photo, and wraps into the edit", async () => {
    await commands.storageCors();
    canvasCamera();
    const { page, videoId, user } = await openShoot(
      { audio: "music", shots: [walkIn, smile] },
      "shot=1&audio=original",
    );
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Take the photo" }));
    const preview = page.getByRole("img", { name: "Your photo" });
    await expect.element(preview, { timeout: 6_000 }).toBeVisible();
    expect(preview.element().getAttribute("src")).toMatch(/^blob:/);
    await userEvent.click(page.getByRole("button", { name: /Keep it/ }));
    await commands.checkUpload(await lastUpload(user));
    await expect.poll(currentUrl).toBe(`/director/${videoId}/edit?audio=original&wrap=1`);
  });

  it("takes a retake asked for in the editor back to the editor, not on to the next shot", async () => {
    await commands.storageCors();
    canvasCamera();
    const { page, videoId, user } = await openShoot(
      { audio: "music", shots: [smile, walkIn] },
      "shot=0&audio=original&back=edit",
    );
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Take the photo" }));
    await userEvent.click(page.getByRole("button", { name: /Keep it/ }), { timeout: 6_000 });
    await commands.checkUpload(await lastUpload(user));
    await expect.poll(currentUrl).toBe(`/director/${videoId}/edit?audio=original`);
  });

  it("says why the take couldn't be sent, and lets the member try again", async () => {
    await commands.storageCors();
    canvasCamera();
    const { page, user } = await openShoot({ shots: [smile] });
    await startShooting(page);
    await userEvent.click(page.getByRole("button", { name: "Take the photo" }));
    await userEvent.click(page.getByRole("button", { name: /Keep it/ }), { timeout: 6_000 });
    await commands.checkUpload(await lastUpload(user), "FILE_INFECTED");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("That file looks harmful, so it was deleted.");
    await expect.element(page.getByRole("button", { name: /Keep it/ })).toBeEnabled();
  });
});
