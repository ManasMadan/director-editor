/**
 * Director Live: one shot at a time, guided into place, recorded (or photographed),
 * reviewed in the Director's Cut, kept and sent. The camera, the screen share, the tilt
 * sensor, the speech recogniser and the on-device models are stand-ins; the recorder, the
 * speech synthesis and the API are the browser's and the app's own.
 */
import type { KeypointName } from "@repo/contracts/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ShootPage } from "@/modules/director";
import { createThingDetector } from "@/modules/director/lib/object-detector";
import { createPoseDetector } from "@/modules/director/lib/pose-detector";
import { cleanup as cleanupPage, currentUrl, renderPage } from "../render";
import { signUp, type User } from "../users";
import {
  cameraStream,
  canvasCamera,
  FakeRecognizer,
  fakeRecognizer,
  newVideoId,
  planShot,
  readyPlan,
  shotPlan,
  tiltPhone,
  touch,
} from "./support";

vi.mock("@/modules/director/lib/pose-detector", () => ({ createPoseDetector: vi.fn() }));
vi.mock("@/modules/director/lib/object-detector", () => ({ createThingDetector: vi.fn() }));

const standing: [KeypointName, number, number][] = [
  ["nose", 0.5, 0.2],
  ["left_shoulder", 0.35, 0.35],
  ["right_shoulder", 0.65, 0.35],
  ["left_hip", 0.4, 0.6],
  ["right_hip", 0.6, 0.6],
  ["left_ankle", 0.4, 0.9],
  ["right_ankle", 0.6, 0.9],
];
const keypoints = standing.map(([name, x, y]) => ({ name, x, y }));
const body = (shiftX = 0) =>
  Object.fromEntries(standing.map(([name, x, y]) => [name, { x: x + shiftX, y }]));

/** The pose model finds `found` in every frame (null: no one), or fails to load. */
function poseModel(found: ReturnType<typeof body> | null | Error) {
  const model = vi.mocked(createPoseDetector);
  if (found instanceof Error) {
    model.mockRejectedValue(found);
  } else {
    model.mockResolvedValue({ detect: () => found, close: vi.fn() });
  }
}

/** What Director has said aloud so far. */
function speech() {
  const speak = vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => undefined);
  return () => speak.mock.calls.map(([utterance]) => utterance.text);
}

/** The object detector finds a plant at the frame's left, or fails to load. */
function thingsModel(found: "plant" | Error) {
  const model = vi.mocked(createThingDetector);
  if (found instanceof Error) {
    model.mockRejectedValue(found);
  } else {
    const plant = {
      thing: found,
      role: "backdrop" as const,
      score: 0.9,
      box: { x: 0.05, y: 0.3, width: 0.25, height: 0.4 },
    };
    model.mockResolvedValue({ detect: () => [plant], close: vi.fn() });
  }
}

/** A touch device, where the browser asks before the page may read the tilt. */
function touchPhone() {
  Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
  vi.spyOn(
    DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> },
    "requestPermission",
  ).mockResolvedValue("granted");
}

beforeEach(() => {
  poseModel(new Error("offline"));
  thingsModel(new Error("offline"));
  fakeRecognizer();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "maxTouchPoints");
});

/** What the caption at the viewport's foot says now. */
const caption = (page: Awaited<ReturnType<typeof renderPage>>, text: string | RegExp) =>
  expect.element(page.getByText(text), { timeout: 15_000 });

const walkIn = planShot({
  title: "Walk in",
  camera: "front",
  pose: { description: "Standing tall.", keypoints },
  steps: [
    { atSeconds: 0, instruction: "Walk towards the camera.", cameraMove: "static" },
    { atSeconds: 0.4, instruction: "Raise the phone slowly.", cameraMove: "up" },
  ],
  script: [
    { startSeconds: 0, endSeconds: 0.6, text: "Morning." },
    { startSeconds: 0.6, endSeconds: 3, text: "Coffee first." },
  ],
});
const smile = planShot({ kind: "photo", title: "Smile", durationSeconds: 1, scene: "Kitchen" });

async function openShoot(
  plan: Parameters<typeof shotPlan>[0],
  query: { shot?: string; audio?: string },
): Promise<{ page: Awaited<ReturnType<typeof renderPage>>; videoId: string; user: User }> {
  const videoId = newVideoId();
  await readyPlan(videoId, shotPlan(plan));
  const user = await signUp();
  const page = await renderPage(
    <ShootPage videoId={videoId} shot={query.shot} audio={query.audio} />,
    {
      url: `/director/${videoId}/shoot`,
    },
  );
  return { page, videoId, user };
}

/** The take the page uploaded last, once storage has it. */
async function lastUpload(user: User) {
  await expect.poll(() => commands.answeredRequests("/rpc/files/completeUpload")).toBe(1);
  const [row] = await commands.sql<{ id: string }>(
    "SELECT id::text FROM files.file WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [user.id],
  );
  return row?.id as string;
}

const record = (page: Awaited<ReturnType<typeof renderPage>>) => {
  touch();
  return userEvent.click(page.getByRole("button", { name: "Record" }));
};

/** Presses a dock button, waking the dock first as a touch would. */
const press = (page: Awaited<ReturnType<typeof renderPage>>, name: string) => {
  touch();
  return userEvent.click(page.getByRole("button", { name }));
};

describe("Director's camera before the plan is ready", () => {
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

describe("Director Live", () => {
  it("asks for the camera again after it was refused, or says there's none", async () => {
    const camera = canvasCamera(new DOMException("denied", "NotAllowedError"));
    const { page } = await openShoot({}, { shot: "0", audio: "voice" });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Director needs your camera. Allow it in your browser's settings, then try again.",
      );
    await expect.element(page.getByText("Let's get the camera on")).toBeVisible();
    camera.getUserMedia.mockRejectedValue(new DOMException("none", "NotFoundError"));
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("There's no camera Director can use on this device.");
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
    await expect.element(page.getByRole("button", { name: "Record" })).toBeDisabled();
  });

  it("starts at the first shot for a shot it can't read, and at the last past the end", async () => {
    canvasCamera();
    const first = await openShoot({ shots: [walkIn, smile] }, { shot: "next", audio: "voice" });
    await expect.element(first.page.getByRole("img", { name: "Shot 1 of 2" })).toBeVisible();
    await expect.element(first.page.getByText("Take 1 • Medium shot")).toBeVisible();
  });

  it("opens the last shot when asked for one past the end", async () => {
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] }, { shot: "7", audio: undefined });
    await expect.element(page.getByRole("img", { name: "Shot 2 of 2" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Take the photo" })).toBeVisible();
  });

  it("opens the first shot without one asked for, and films a shot with no steps to follow", async () => {
    canvasCamera();
    const videoId = newVideoId();
    await readyPlan(
      videoId,
      shotPlan({ shots: [planShot({ title: "Pour", durationSeconds: 0.5 }), smile] }),
    );
    await signUp();
    // The API's contract allows a shot without steps, though Director always gives one:
    // its answer, as the API would send such a plan.
    const answer = await fetch("/rpc/director/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { videoId } }),
    }).then(
      (response) =>
        response.json() as Promise<{ json: { plan: { shots: { steps: unknown[] }[] } } }>,
    );
    const [first] = answer.json.plan.shots;
    if (first) {
      first.steps = [];
    }
    await commands.failRequests("/rpc/director/plan", { status: 200, body: answer });
    const page = await renderPage(<ShootPage videoId={videoId} shot={undefined} audio="voice" />, {
      url: `/director/${videoId}/shoot`,
    });
    await expect.element(page.getByRole("img", { name: "Shot 1 of 2" })).toBeVisible();
    await record(page);
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    // The take ends by itself, and Director's Cut loops its best moment.
    await expect
      .element(page.getByLabelText("Best moment, on loop"), { timeout: 15_000 })
      .toBeVisible();
    await expect.element(page.getByText("Director's cut")).toBeVisible();
  });

  it("greets the member, guides them into place, and draws it over the camera", async () => {
    const said = speech();
    const camera = canvasCamera();
    poseModel(body());
    touchPhone();
    const { page, videoId } = await openShoot(
      { shots: [walkIn, smile] },
      { shot: "0", audio: "voice" },
    );
    // A video with the member's voice: the front camera, and the microphone, cleaned up.
    await expect.poll(() => camera.opened).toHaveLength(1);
    expect(camera.opened[0]).toMatchObject({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: { facingMode: "user" },
    });
    await expect
      .element(page.getByRole("link", { name: "End the session" }))
      .toHaveAttribute("href", `/director/${videoId}`);
    // Mirrored, as the front camera's preview always is.
    expect(document.querySelector("video:not(.blur-3xl)")?.className).toContain("-scale-x-100");
    await expect
      .poll(() => said())
      .toContain("Hi, I'm your director! First up: Walk in. By a window. Let's make it gorgeous.");
    await expect.element(page.getByText("Live")).toBeVisible();

    // Director's doodles are drawn over the camera.
    const doodles = document.querySelector("canvas") as HTMLCanvasElement;
    await expect
      .poll(() => {
        const { data } = (doodles.getContext("2d") as CanvasRenderingContext2D).getImageData(
          0,
          0,
          doodles.width,
          doodles.height,
        );
        return data.some((value, at) => at % 4 === 3 && value > 0);
      })
      .toBe(true);

    // The angle joins the ready check once the browser lets the page read the tilt.
    expect(page.getByTitle("Angle").query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Use the phone's tilt" }));
    tiltPhone(90, 20);
    await expect.element(page.getByTitle("Angle")).toBeVisible();
    await caption(page, "Lean it left").toBeVisible();
    tiltPhone(90, 0);

    // Turning Director's voice off, and choosing the countdown.
    const voice = page.getByRole("button", { name: "Director's voice" });
    touch();
    await userEvent.click(voice);
    await expect.element(voice).toHaveAttribute("aria-pressed", "false");
    touch();
    await userEvent.click(page.getByRole("button", { name: "Countdown: 3 seconds" }));
    await expect
      .element(page.getByRole("button", { name: "Countdown: 3 seconds" }))
      .toHaveTextContent("3s");
  });

  it("says where to go from what the camera sees, until the member is there", async () => {
    const said = speech();
    canvasCamera();
    const { page, videoId } = await openShoot({ shots: [walkIn] }, { shot: "0", audio: "voice" });
    await commands.fakeDirector(videoId, {
      scene: {
        inPlace: false,
        instruction: "Move about three meters left, to the window.",
        direction: "left",
        distanceMeters: 3,
        landmark: { label: "window", box: { x: 0.1, y: 0.2, width: 0.3, height: 0.5 } },
        lighting: "backlit",
      },
    });
    await caption(page, "Move about three meters left, to the window.").toBeVisible();
    expect(said()).toContain("The light's behind you. Turn so it falls on your face.");
    await commands.fakeDirector(videoId, {
      scene: {
        inPlace: true,
        instruction: "You're there.",
        direction: "none",
        distanceMeters: null,
        landmark: null,
        lighting: "good",
      },
    });
    await caption(page, "Great spot! Right there.").toBeVisible();
  });

  it("points out what's in the frame, and asks the member to step in", async () => {
    const said = speech();
    canvasCamera();
    poseModel(null);
    thingsModel("plant");
    const { page } = await openShoot(
      { shots: [planShot({ ...walkIn, sceneLandmark: null, pose: walkIn.pose })] },
      { shot: "0", audio: "voice" },
    );
    await caption(page, "Step into the frame").toBeVisible();
    await expect
      .poll(() => said(), { timeout: 15_000 })
      .toContain("Nice plant back there. Good depth.");
  });

  it("films along to the original: no microphone, the original playing, every step called", async () => {
    const said = speech();
    const camera = canvasCamera();
    const { page } = await openShoot(
      { audio: "music", shots: [planShot({ title: "Pour", steps: walkIn.steps })] },
      { shot: "0", audio: "voice" },
    );
    await expect.poll(() => camera.opened).toHaveLength(1);
    expect(camera.opened[0]).toMatchObject({ audio: false, video: { facingMode: "environment" } });
    expect(document.querySelector("video:not(.blur-3xl)")?.className).not.toContain("-scale-x-100");

    await record(page);
    await expect.element(page.getByText("3", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect.element(page.getByText("00:00")).toBeVisible();
    const original = page.getByTitle("The original's audio plays while you film.");
    await expect.element(original).toBeInTheDocument();
    const params = new URL(original.element().getAttribute("src") as string).searchParams;
    expect([params.get("start"), params.get("end"), params.get("mute")]).toEqual(["1", "4", "0"]);
    await expect.element(page.getByText("Raise the phone slowly.")).toBeVisible();
    // Silent takes: Director calls them like a set.
    await expect
      .poll(() => said())
      .toEqual(
        expect.arrayContaining([
          "Quiet on set. Rolling in 3.",
          "2",
          "1",
          "Action! Walk towards the camera.",
          "Raise the phone slowly.",
        ]),
      );
    expect(page.getByRole("region", { name: "Teleprompter" }).query()).toBeNull();

    // The take stops by itself a moment after the shot's length: cut, and its review.
    await expect
      .element(page.getByLabelText("Best moment, on loop"), { timeout: 15_000 })
      .toBeVisible();
    expect(page.getByTitle("The original's audio plays while you film.").query()).toBeNull();
    await expect.poll(() => said()).toContain("Cut!");
  });

  it("says when this browser can't record, and goes back to getting ready", async () => {
    vi.spyOn(MediaRecorder, "isTypeSupported").mockReturnValue(false);
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn] }, { shot: "0", audio: "voice" });
    await record(page);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Director couldn't start the camera's recording here. Try again, or another browser.",
      );
    await expect.element(page.getByRole("button", { name: "Record" })).toBeEnabled();
    // Trying again clears it until it fails again.
    await record(page);
    expect(page.getByRole("alert").query()).toBeNull();
  });

  it("does what the member says: action, cut, go again, flip, quiet, talk", async () => {
    const said = speech();
    const camera = canvasCamera();
    const { page } = await openShoot(
      { audio: "music", shots: [planShot({ title: "Pour", durationSeconds: 5 })] },
      { shot: "0", audio: "original" },
    );
    await expect.poll(() => FakeRecognizer.last?.started).toBe(1);
    // The page starts listening afresh whenever the camera reopens (a flip): the member
    // always speaks into its latest recogniser.
    const ears = () => FakeRecognizer.last as FakeRecognizer;
    expect(ears().lang).toBe("en");
    // Words still being heard show as the member says them.
    ears().hear("let's", { final: false });
    await expect.element(page.getByText("let's", { exact: true })).toBeVisible();
    // A phrase the recogniser doubts, or that isn't a request, does nothing.
    ears().hear("action", { confidence: 0.1 });
    ears().hear("what a lovely day");
    ears().hear("flip the camera");
    await expect.poll(() => camera.opened).toHaveLength(2);
    expect(camera.opened[1]).toMatchObject({ video: { facingMode: "user" } });
    ears().hear("quiet");
    await expect
      .element(page.getByRole("button", { name: "Director's voice" }))
      .toHaveAttribute("aria-pressed", "false");
    ears().hear("talk to me");
    await expect
      .element(page.getByRole("button", { name: "Director's voice" }))
      .toHaveAttribute("aria-pressed", "true");
    ears().hear("repeat");
    ears().hear("action");
    await expect
      .element(page.getByRole("button", { name: "Stop" }), { timeout: 10_000 })
      .toBeVisible();
    ears().hear("cut");
    await expect.element(page.getByLabelText("Best moment, on loop")).toBeVisible();
    ears().hear("go again");
    await expect.poll(() => said()).toContain("Back to one. Let's go again!");
    await expect.element(page.getByText("Take 2 • Medium shot")).toBeVisible();
    // The recogniser stops by itself on silence: it's started again.
    const listening = ears();
    listening.stop();
    await expect.poll(() => listening.started).toBe(2);
    // A microphone the browser won't allow: it says so, and stops trying.
    ears().fail("not-allowed");
    await expect
      .element(page.getByRole("button", { name: /Allow the microphone/ }))
      .toBeInTheDocument();
  });

  it("listens only when asked", async () => {
    canvasCamera();
    const { page } = await openShoot({ shots: [walkIn] }, { shot: "0", audio: "voice" });
    await press(page, "Stop listening");
    await expect.element(page.getByRole("button", { name: "Talk to Director" })).toBeVisible();
    expect(FakeRecognizer.last?.aborted).toBe(true);
  });

  it("says where the browser can't hear, and leaves its talk button off", async () => {
    canvasCamera();
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const { page } = await openShoot({ shots: [walkIn] }, { shot: "0", audio: "voice" });
    await expect
      .element(page.getByRole("button", { name: /can't hear you/ }).first())
      .toBeDisabled();
  });

  it("pauses, and shows Director the screen instead of the camera", async () => {
    canvasCamera();
    const screen = cameraStream();
    const share = vi
      .spyOn(navigator.mediaDevices, "getDisplayMedia")
      .mockResolvedValueOnce(screen)
      .mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"))
      .mockRejectedValueOnce(new DOMException("broken", "NotReadableError"));
    const { page } = await openShoot({ shots: [walkIn] }, { shot: "0", audio: "voice" });
    await press(page, "Pause Director");
    await expect.element(page.getByText("Paused")).toBeVisible();
    await press(page, "Resume Director");
    await expect.element(page.getByText("Live")).toBeVisible();

    await press(page, "Show Director your screen");
    await expect.element(page.getByText("Director is looking at your screen")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Switch back to the camera to record." }))
      .toBeDisabled();
    // Ending the share from the browser's own bar brings the camera back.
    for (const track of screen.getVideoTracks()) {
      track.dispatchEvent(new Event("ended"));
    }
    await expect.element(page.getByRole("button", { name: "Record" })).toBeEnabled();
    // Cancelling the picker isn't a failure; a share that breaks is.
    await press(page, "Show Director your screen");
    await press(page, "Show Director your screen");
    await expect.poll(() => share.mock.calls.length).toBe(3);
  });

  it("starts a take when the member holds a hand up", async () => {
    canvasCamera();
    poseModel({ ...body(), right_wrist: { x: 0.6, y: 0.05 } });
    const { page } = await openShoot({ shots: [walkIn] }, { shot: "0", audio: "voice" });
    await expect.element(page.getByText("3", { exact: true }), { timeout: 10_000 }).toBeVisible();
  });

  it("remembers the member: welcomes them back next time", async () => {
    const said = speech();
    canvasCamera();
    const { videoId } = await openShoot({ shots: [walkIn] }, { shot: "0", audio: "voice" });
    await expect
      .poll(() => said())
      .toContain("Hi, I'm your director! First up: Walk in. By a window. Let's make it gorgeous.");
    await cleanupPage();
    const page = await renderPage(<ShootPage videoId={videoId} shot="0" audio="voice" />, {
      url: `/director/${videoId}/shoot`,
    });
    await expect.element(page.getByText("Live")).toBeVisible();
    await expect.poll(() => said()).toContain("Welcome back! Walk in. By a window.");
  });
});

// Takes are uploaded to RustFS: the files profile (`bun run test:integration:files`).
describe("sending a take", { tags: ["files"] }, () => {
  it("records the member's voice with the teleprompter, goes again, and keeps the take", async () => {
    await commands.storageCors();
    const said = speech();
    canvasCamera();
    const { page, videoId, user } = await openShoot(
      { shots: [walkIn, smile] },
      { shot: "0", audio: "voice" },
    );
    await expect.element(page.getByRole("button", { name: "Record" })).toBeEnabled();
    await record(page);
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    const prompter = page.getByRole("region", { name: "Teleprompter" });
    await expect
      .element(prompter.getByRole("listitem").nth(1))
      .toHaveAttribute("aria-current", "true");
    // A take with the member's voice has no Director's voice in it.
    expect(said().some((line) => line.startsWith("Action!"))).toBe(false);

    await userEvent.click(page.getByRole("button", { name: "Stop" }));
    await expect.element(page.getByLabelText("Best moment, on loop")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Go again" }));
    await expect.element(page.getByRole("button", { name: "Record" })).toBeEnabled();

    await record(page);
    await userEvent.click(page.getByRole("button", { name: "Stop" }));
    await userEvent.click(page.getByRole("button", { name: "Keep it" }));
    await commands.checkUpload(await lastUpload(user));
    await expect.poll(currentUrl).toBe(`/director/${videoId}/shoot?shot=1&audio=voice`);
  });

  it("takes the last shot's photo, and wraps into the edit", async () => {
    await commands.storageCors();
    canvasCamera();
    const { page, videoId, user } = await openShoot(
      { audio: "music", shots: [walkIn, smile] },
      { shot: "1", audio: "original" },
    );
    await expect.element(page.getByRole("img", { name: "Shot 2 of 2" })).toBeVisible();
    await press(page, "Take the photo");
    const preview = page.getByRole("img", { name: "Director's cut" });
    await expect.element(preview).toBeVisible();
    expect(preview.element().getAttribute("src")).toMatch(/^blob:/);
    await userEvent.click(page.getByRole("button", { name: /Keep it/ }));
    await commands.checkUpload(await lastUpload(user));
    await expect.poll(currentUrl).toBe(`/director/${videoId}/review?audio=original&wrap=1`);
  });

  it("says why the take couldn't be sent, and lets the member try again", async () => {
    await commands.storageCors();
    canvasCamera();
    const { page, user } = await openShoot({ shots: [smile] }, { shot: "0", audio: "voice" });
    await press(page, "Take the photo");
    await userEvent.click(page.getByRole("button", { name: /Keep it/ }));
    await commands.checkUpload(await lastUpload(user), "FILE_INFECTED");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("That file looks harmful, so it was deleted.");
    await expect.element(page.getByRole("button", { name: /Keep it/ })).toBeEnabled();
  });
});
