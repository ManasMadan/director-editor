/**
 * Director's camera: one shot at a time, guided into place, recorded (or photographed),
 * kept and sent. The camera, the tilt sensor and the pose model are stand-ins; the
 * recorder, the speech and the API are the browser's and the app's own.
 */
import type { KeypointName } from "@repo/contracts/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ShootPage } from "@/modules/director";
import { createPoseDetector } from "@/modules/director/lib/pose-detector";
import { currentUrl, renderPage } from "../render";
import { signUp, type User } from "../users";
import { fakeCamera, newVideoId, readyPlan, shot, shotPlan, tiltPhone } from "./support";

vi.mock("@/modules/director/lib/pose-detector", () => ({ createPoseDetector: vi.fn() }));

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

beforeEach(() => {
  poseModel(new Error("offline"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const walkIn = shot({
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
const smile = shot({ kind: "photo", title: "Smile", durationSeconds: 1, scene: "Kitchen" });

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

const record = (page: Awaited<ReturnType<typeof renderPage>>) =>
  userEvent.click(page.getByRole("button", { name: "Record" }));

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

describe("Director's camera", () => {
  it("asks for the camera again after it was refused, or says there's none", async () => {
    const camera = fakeCamera(new DOMException("denied", "NotAllowedError"));
    const { page } = await openShoot({}, { shot: "0", audio: "voice" });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Director needs your camera. Allow it in your browser's settings, then try again.",
      );
    camera.getUserMedia.mockRejectedValue(new DOMException("none", "NotFoundError"));
    await userEvent.click(page.getByRole("button", { name: "Start the camera" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("There's no camera Director can use on this device.");
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
    await expect.element(page.getByRole("button", { name: "Record" })).toBeDisabled();
  });

  it("starts at the first shot for a shot it can't read, and at the last past the end", async () => {
    fakeCamera();
    const first = await openShoot({ shots: [walkIn, smile] }, { shot: "next", audio: "voice" });
    await expect.element(first.page.getByText("Shot 1 of 2")).toBeVisible();
    await expect.element(first.page.getByText("Walk in")).toBeVisible();
  });

  it("opens the last shot when asked for one past the end", async () => {
    fakeCamera();
    const { page } = await openShoot({ shots: [walkIn, smile] }, { shot: "7", audio: undefined });
    await expect.element(page.getByText("Shot 2 of 2")).toBeVisible();
    await expect.element(page.getByText("Smile")).toBeVisible();
  });

  it("opens the first shot without one asked for, and films a shot with no steps to follow", async () => {
    fakeCamera();
    const videoId = newVideoId();
    await readyPlan(
      videoId,
      shotPlan({ shots: [shot({ title: "Pour", durationSeconds: 0.5 }), smile] }),
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
    await expect.element(page.getByText("Shot 1 of 2")).toBeVisible();
    expect(page.getByText("Step", { exact: false }).query()).toBeNull();
    await record(page);
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    expect(page.getByText("Step", { exact: false }).query()).toBeNull();
    await expect.element(page.getByLabelText("Your take")).toBeVisible();
  });

  it("guides the member into place: the pose, the framing, the spot, the angle", async () => {
    const said = speech();
    const camera = fakeCamera();
    poseModel(body());
    vi.spyOn(
      DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> },
      "requestPermission",
    ).mockResolvedValue("granted");
    const { page, videoId } = await openShoot(
      { shots: [walkIn, smile] },
      { shot: "0", audio: "voice" },
    );
    // A video with the member's voice: the front camera, and the microphone.
    await expect.poll(() => camera.opened).toHaveLength(1);
    expect(camera.opened[0]).toMatchObject({ audio: true, video: { facingMode: "user" } });
    await expect.element(page.getByText("Shot 1 of 2")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Back" }))
      .toHaveAttribute("href", `/director/${videoId}`);
    // Mirrored, as the front camera's preview always is.
    expect(document.querySelector("video")?.className).toContain("-scale-x-100");
    await expect.element(page.getByText("Hold the phone at chest height")).toBeVisible();
    await expect.element(page.getByText("Pose matched")).toBeVisible();
    await expect.element(page.getByText("You're in frame")).toBeVisible();
    await expect.poll(() => said()).toContain("Next: Walk in. By a window.");

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

    // The level shows the phone's angle once the browser lets it read the sensor.
    await userEvent.click(page.getByRole("button", { name: "Use the phone's tilt" }));
    await expect.element(page.getByText("The angle guide works on a phone.")).toBeVisible();
    tiltPhone(90, 0);
    await expect.element(page.getByText("Angle locked")).toBeVisible();
    tiltPhone(90, 20);
    await expect.element(page.getByText("Lean it left")).toBeVisible();

    // Turning Director's voice off.
    const voice = page.getByRole("button", { name: "Read directions aloud" });
    await expect.element(voice).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(voice);
    await expect.element(voice).toHaveAttribute("aria-pressed", "false");
  });

  it("says where to go from what the camera sees, until the member is there", async () => {
    const said = speech();
    fakeCamera();
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
    await expect
      .element(
        page.getByText("Move about three meters left, to the window. · The light is behind you"),
      )
      .toBeVisible();
    expect(said()).toContain("Move about three meters left, to the window.");
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
    await expect.element(page.getByText("Great spot.", { exact: true })).toBeVisible();
    expect(said()).toContain("Great spot.");
  });

  it("tells the member to step in, or to change their pose", async () => {
    fakeCamera();
    poseModel(null);
    const { page } = await openShoot({ shots: [walkIn] }, { shot: "0", audio: "voice" });
    await expect.element(page.getByText("Step into the frame")).toBeVisible();
    await expect.element(page.getByText("Match the outline")).toBeVisible();
  });

  it("films along to the original: no microphone, the original playing, every step said", async () => {
    const said = speech();
    const camera = fakeCamera();
    const { page } = await openShoot(
      { audio: "music", shots: [shot({ title: "Pour", steps: walkIn.steps })] },
      { shot: "0", audio: "voice" },
    );
    await expect.poll(() => camera.opened).toHaveLength(1);
    expect(camera.opened[0]).toMatchObject({ audio: false, video: { facingMode: "environment" } });
    expect(document.querySelector("video")?.className).not.toContain("-scale-x-100");
    await expect
      .element(page.getByText("The original's audio plays while you film."))
      .toBeVisible();
    // No one to pose: no pose guide, no framing.
    expect(page.getByText("Match the outline").query()).toBeNull();
    expect(page.getByText("The pose guide couldn't load.", { exact: false }).query()).toBeNull();

    await record(page);
    await expect.element(page.getByText("3", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect.element(page.getByText("Recording")).toBeVisible();
    const original = page.getByTitle("The original's audio plays while you film.");
    await expect.element(original).toBeInTheDocument();
    const params = new URL(original.element().getAttribute("src") as string).searchParams;
    expect([params.get("start"), params.get("end"), params.get("mute")]).toEqual(["1", "4", "0"]);
    await expect.element(page.getByText("Step 2")).toBeVisible();
    expect(page.getByText("Step 2").element().parentElement?.textContent).toBe(
      "Step 2Raise the phone slowly.",
    );
    // Silent takes: Director talks the member through them.
    await expect
      .poll(() => said())
      .toEqual(expect.arrayContaining(["3", "2", "1", "Action!", "Raise the phone slowly."]));
    expect(page.getByRole("region", { name: "Teleprompter" }).query()).toBeNull();

    // The take stops by itself a moment after the shot's length.
    await expect.element(page.getByLabelText("Your take"), { timeout: 10_000 }).toBeVisible();
    expect(page.getByTitle("The original's audio plays while you film.").query()).toBeNull();
  });

  it("says when this browser can't record, and goes back to getting ready", async () => {
    vi.spyOn(MediaRecorder, "isTypeSupported").mockReturnValue(false);
    fakeCamera();
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
});

// Takes are uploaded to RustFS: the files profile (`bun run test:integration:files`).
describe("sending a take", { tags: ["files"] }, () => {
  it("records the member's voice with the teleprompter, redoes it, and sends the take", async () => {
    await commands.storageCors();
    const said = speech();
    fakeCamera();
    const { page, videoId, user } = await openShoot(
      { shots: [walkIn, smile] },
      { shot: "0", audio: "voice" },
    );
    await expect.element(page.getByRole("button", { name: "Record" })).toBeEnabled();
    await record(page);
    await expect.element(page.getByRole("button", { name: "Record" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    const prompter = page.getByRole("region", { name: "Teleprompter" });
    await expect
      .element(prompter.getByRole("listitem").nth(1))
      .toHaveAttribute("aria-current", "true");
    await expect.element(page.getByText("Step 2")).toBeVisible();
    // A take with the member's voice has no Director's voice in it.
    expect(said()).not.toContain("Action!");

    await userEvent.click(page.getByRole("button", { name: "Stop" }));
    const preview = page.getByLabelText("Your take");
    await expect.element(preview).toBeVisible();
    expect(preview.element().tagName).toBe("VIDEO");
    expect(preview.element().querySelector("track")?.getAttribute("src")).toMatch(/^blob:/);
    expect(page.getByRole("region", { name: "Teleprompter" }).query()).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "Retake" }));
    await expect.element(page.getByRole("button", { name: "Record" })).toBeEnabled();
    expect(page.getByLabelText("Your take").query()).toBeNull();

    await record(page);
    await userEvent.click(page.getByRole("button", { name: "Stop" }));
    await userEvent.click(page.getByRole("button", { name: "Use this take" }));
    await expect
      .element(page.getByRole("button", { name: /Sending your take to Director…$/ }))
      .toBeDisabled();
    await commands.checkUpload(await lastUpload(user));
    await expect.poll(currentUrl).toBe(`/director/${videoId}/shoot?shot=1&audio=voice`);
  });

  it("takes the last shot's photo, and goes on to the edit", async () => {
    await commands.storageCors();
    fakeCamera();
    const { page, videoId, user } = await openShoot(
      { audio: "music", shots: [walkIn, smile] },
      { shot: "1", audio: "original" },
    );
    await expect.element(page.getByText("Shot 2 of 2")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Take the photo" }));
    const preview = page.getByRole("img", { name: "Your take" });
    await expect.element(preview).toBeVisible();
    expect(preview.element().getAttribute("src")).toMatch(/^blob:/);
    await userEvent.click(page.getByRole("button", { name: "Use this take" }));
    await commands.checkUpload(await lastUpload(user));
    await expect.poll(currentUrl).toBe(`/director/${videoId}/review?audio=original`);
  });

  it("says why the take couldn't be sent, and lets the member try again", async () => {
    await commands.storageCors();
    fakeCamera();
    const { page, user } = await openShoot({ shots: [smile] }, { shot: "0", audio: "voice" });
    await userEvent.click(page.getByRole("button", { name: "Take the photo" }));
    await userEvent.click(page.getByRole("button", { name: "Use this take" }));
    await commands.checkUpload(await lastUpload(user), "FILE_INFECTED");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("That file looks harmful, so it was deleted.");
    await expect.element(page.getByRole("button", { name: "Use this take" })).toBeEnabled();
    await expect.element(page.getByRole("img", { name: "Your take" })).toBeVisible();
  });
});
