/**
 * Director's shorts, plans and takes for the browser tests, and stand-ins for the phone's
 * hardware: a camera (a canvas that keeps drawing) and the tilt sensor.
 */
import type { DirectorTake, Shot, ShotPlan } from "@repo/contracts/api";
import { vi } from "vitest";
import { commands, userEvent } from "vitest/browser";

/** A short of its own for each test: the AI stand-in keeps Director's answers per short. */
export const newVideoId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 11);

export function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    kind: "video",
    title: "Walk in",
    purpose: "Set the scene.",
    sourceStartSeconds: 1.2,
    sourceEndSeconds: 3.6,
    durationSeconds: 2,
    camera: "back",
    scene: "By a window",
    sceneLandmark: "window",
    framing: {
      shotSize: "medium",
      subject: { x: 0.25, y: 0.2, width: 0.5, height: 0.7 },
      note: "Waist up.",
    },
    phoneAngle: { pitch: 0, roll: 0, tolerance: 6, height: "chest" },
    pose: { description: "Standing.", keypoints: [] },
    steps: [{ atSeconds: 0, instruction: "Walk towards the camera.", cameraMove: "static" }],
    script: [],
    ...overrides,
  };
}

export function shotPlan(overrides: Partial<ShotPlan> = {}): ShotPlan {
  return {
    title: "Morning routine",
    format: "GRWM",
    summary: "Coffee, a window and a smile.",
    audio: "speech",
    durationSeconds: 75,
    shots: [shot()],
    ...overrides,
  };
}

/** The short's plan, ready, as Director answers it. */
export const readyPlan = (videoId: string, plan: ShotPlan) =>
  commands.fakeDirector(videoId, { plan: { status: "ready", plan } });

/** A take as the AI service lists it (`createdAt` as JSON carries it). */
export function take(overrides: Partial<Omit<DirectorTake, "createdAt">> & { fileId: string }) {
  return {
    id: crypto.randomUUID(),
    shotIndex: 0,
    kind: "video",
    status: "ready",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score: null,
    feedback: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A canvas that keeps changing: something for a camera or a recorder to show. */
function movingCanvas(width = 360, height = 640) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  let frame = 0;
  const timer = window.setInterval(() => {
    frame += 1;
    ctx.fillStyle = `hsl(${(frame * 12) % 360} 70% 50%)`;
    ctx.fillRect(0, 0, width, height);
  }, 33);
  return { canvas, stop: () => window.clearInterval(timer) };
}

/**
 * The browser's camera, as a canvas's stream (with a tone for the microphone when sound
 * is asked for), or `refusal` thrown the way getUserMedia throws it.
 */
export function fakeCamera(refusal?: DOMException) {
  const opened: MediaStreamConstraints[] = [];
  const getUserMedia = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(async (constraints = {}) => {
      opened.push(constraints);
      if (refusal) {
        throw refusal;
      }
      const { canvas, stop } = movingCanvas();
      const stream = canvas.captureStream(30);
      // The picture stops changing once the page turns the camera off.
      for (const track of stream.getTracks()) {
        const end = track.stop.bind(track);
        track.stop = () => {
          end();
          stop();
        };
      }
      if (constraints.audio) {
        const audio = new AudioContext();
        const tone = audio.createOscillator();
        const out = audio.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        for (const track of out.stream.getAudioTracks()) {
          stream.addTrack(track);
        }
      }
      return stream;
    });
  return { opened, getUserMedia };
}

/** The phone held at `beta`/`gamma` degrees, as the orientation sensor reports it. */
export function tiltPhone(beta: number, gamma: number) {
  window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", { beta, gamma }));
}

/** A short WebM of a moving picture (with a tone when `withSound`), as a take records it. */
export async function recordVideo(seconds: number, withSound = false): Promise<Blob> {
  const { canvas, stop } = movingCanvas(180, 320);
  const stream = canvas.captureStream(30);
  let audio: AudioContext | null = null;
  if (withSound) {
    // Sound starts only after the page has been interacted with.
    await userEvent.click(document.body);
    audio = new AudioContext();
    await audio.resume();
    const tone = audio.createOscillator();
    const out = audio.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    for (const track of out.stream.getAudioTracks()) {
      stream.addTrack(track);
    }
  }
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start(100);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  recorder.stop();
  await stopped;
  stop();
  await audio?.close();
  return new Blob(chunks, { type: "video/webm" });
}

/** A small JPEG photo. */
export async function photo(): Promise<Blob> {
  const { canvas, stop } = movingCanvas(90, 160);
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop();
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob as Blob), "image/jpeg", 0.8),
  );
}
