/**
 * The shot plans the fake Gemini writes, one per kind of short, in the shape Director asks
 * for (apps/ai/app/schemas.py ShotPlan). They follow the Director PRD's examples: a GRWM in
 * six shots (four videos, two photos) with speech, and the pen-drop shoe flaunt in one
 * back-camera video; and the "stand near a tree" talk the PRD's scene example uses.
 * Positions are fractions of a 9:16 portrait frame from its top-left corner.
 */
import type { Template } from "./catalog";

type Point = { name: string; x: number; y: number };

/** A person standing facing the camera, filling `top` to `bottom` of the frame. */
function standing(top: number, bottom: number): Point[] {
  const at = (fraction: number) => top + (bottom - top) * fraction;
  return [
    { name: "nose", x: 0.5, y: at(0.07) },
    { name: "left_shoulder", x: 0.62, y: at(0.2) },
    { name: "right_shoulder", x: 0.38, y: at(0.2) },
    { name: "left_elbow", x: 0.66, y: at(0.36) },
    { name: "right_elbow", x: 0.34, y: at(0.36) },
    { name: "left_wrist", x: 0.64, y: at(0.5) },
    { name: "right_wrist", x: 0.36, y: at(0.5) },
    { name: "left_hip", x: 0.57, y: at(0.53) },
    { name: "right_hip", x: 0.43, y: at(0.53) },
    { name: "left_knee", x: 0.57, y: at(0.76) },
    { name: "right_knee", x: 0.43, y: at(0.76) },
    { name: "left_ankle", x: 0.57, y: at(0.97) },
    { name: "right_ankle", x: 0.43, y: at(0.97) },
  ];
}

/** Head and shoulders, for a close shot (no hips or legs in frame). */
function upperBody(): Point[] {
  return standing(0.12, 1.4).filter((point) => point.y <= 0.95);
}

const eyeLevel = { pitch: 0, roll: 0, tolerance: 8, height: "eye" };
const chest = { pitch: -5, roll: 0, tolerance: 8, height: "chest" };
const fullBody = { x: 0.24, y: 0.06, width: 0.52, height: 0.9 };

const step = (atSeconds: number, instruction: string, cameraMove = "static") => ({
  atSeconds,
  instruction,
  cameraMove,
});
const line = (startSeconds: number, endSeconds: number, text: string) => ({
  startSeconds,
  endSeconds,
  text,
});

const mirror = "In front of a mirror";

const GRWM = {
  title: "Get ready with me",
  format: "GRWM",
  summary: "An outfit built piece by piece in front of a mirror, then the finished look.",
  audio: "speech-and-music",
  durationSeconds: 19,
  shots: [
    {
      kind: "video",
      title: "The top",
      purpose: "Put on the first piece, so the look starts from it.",
      sourceStartSeconds: 0,
      sourceEndSeconds: 3.5,
      durationSeconds: 3.5,
      camera: "front",
      scene: mirror,
      sceneLandmark: "mirror",
      framing: {
        shotSize: "medium",
        subject: { x: 0.18, y: 0.1, width: 0.64, height: 0.8 },
        note: "Waist up, centered.",
      },
      phoneAngle: chest,
      pose: {
        description: "Facing the mirror, pulling the top straight.",
        keypoints: upperBody(),
      },
      steps: [
        step(0, "Hold up your top to the camera."),
        step(1.5, "Put it on and smooth it down."),
      ],
      script: [
        line(0, 1.6, "Okay, first the top."),
        line(1.8, 3.4, "This one goes with everything."),
      ],
    },
    {
      kind: "video",
      title: "The jeans",
      purpose: "Show the second piece going on.",
      sourceStartSeconds: 3.5,
      sourceEndSeconds: 6.5,
      durationSeconds: 3,
      camera: "front",
      scene: mirror,
      sceneLandmark: "mirror",
      framing: { shotSize: "full-body", subject: fullBody, note: "Head to toe." },
      phoneAngle: chest,
      pose: {
        description: "Standing tall, hands on the waistband.",
        keypoints: standing(0.06, 0.96),
      },
      steps: [
        step(0, "Step back so your whole body is in frame."),
        step(1, "Do up the jeans.", "static"),
      ],
      script: [line(0, 2.8, "Then the jeans, high waisted.")],
    },
    {
      kind: "video",
      title: "The full look",
      purpose: "The whole outfit, moving: the shot the edit keeps the best part of.",
      sourceStartSeconds: 6.5,
      sourceEndSeconds: 10.5,
      durationSeconds: 4,
      camera: "front",
      scene: mirror,
      sceneLandmark: "mirror",
      framing: {
        shotSize: "full-body",
        subject: fullBody,
        note: "Head to toe, a little space above.",
      },
      phoneAngle: chest,
      pose: { description: "Standing, weight on one hip.", keypoints: standing(0.06, 0.96) },
      steps: [step(0, "Turn slowly to one side."), step(2, "Turn back and face the mirror.")],
      script: [line(0.2, 3.6, "And that's the full look.")],
    },
    {
      kind: "video",
      title: "Make-up",
      purpose: "A close shot of the finishing touch.",
      sourceStartSeconds: 10.5,
      sourceEndSeconds: 14,
      durationSeconds: 3.5,
      camera: "front",
      scene: "Near a window with daylight",
      sceneLandmark: "window",
      framing: {
        shotSize: "close-up",
        subject: { x: 0.2, y: 0.12, width: 0.6, height: 0.62 },
        note: "Your face fills the frame.",
      },
      phoneAngle: eyeLevel,
      pose: { description: "Face to the light, chin slightly up.", keypoints: [] },
      steps: [step(0, "Hold the phone at eye level."), step(1, "Add your lip colour.", "forward")],
      script: [line(0, 3.2, "Last touch, a little lip colour.")],
    },
    {
      kind: "photo",
      title: "Fit check",
      purpose: "A still of the outfit, held on screen.",
      sourceStartSeconds: 14,
      sourceEndSeconds: 16.5,
      durationSeconds: 2.5,
      camera: "front",
      scene: mirror,
      sceneLandmark: "mirror",
      framing: { shotSize: "full-body", subject: fullBody, note: "Head to toe in the mirror." },
      phoneAngle: chest,
      pose: {
        description: "Hand on hip, looking at the phone.",
        keypoints: standing(0.06, 0.96),
      },
      steps: [step(0, "Strike a pose and hold it.")],
      script: [],
    },
    {
      kind: "photo",
      title: "The full photo",
      purpose: "The closing still: the whole of you.",
      sourceStartSeconds: 16.5,
      sourceEndSeconds: 19,
      durationSeconds: 2.5,
      camera: "front",
      scene: "Anywhere with good light",
      sceneLandmark: null,
      framing: { shotSize: "full-body", subject: fullBody, note: "Centered, head to toe." },
      phoneAngle: chest,
      pose: { description: "Standing tall, smiling.", keypoints: standing(0.06, 0.96) },
      steps: [step(0, "Smile and hold still.")],
      script: [],
    },
  ],
};

const PEN_DROP = {
  title: "Pen drop shoe check",
  format: "Shoe flaunt",
  summary:
    "A pen 'falls', the camera follows it down to the shoes, looks around them, then comes back up.",
  audio: "music",
  durationSeconds: 14,
  shots: [
    {
      kind: "video",
      title: "The drop",
      purpose: "One continuous shot: the pen drop is the excuse to show the shoes.",
      sourceStartSeconds: 0,
      sourceEndSeconds: 14,
      durationSeconds: 14,
      camera: "back",
      scene: "Anywhere with a clear floor",
      sceneLandmark: null,
      framing: {
        shotSize: "close-up",
        subject: { x: 0.18, y: 0.5, width: 0.64, height: 0.42 },
        note: "Your shoes fill the lower half.",
      },
      phoneAngle: { pitch: -15, roll: 0, tolerance: 10, height: "shoulder" },
      pose: { description: "No one in frame: the shoes are the subject.", keypoints: [] },
      steps: [
        step(0, "Keep the back camera near your shoulder, pointing ahead."),
        step(2, "Drop your pen.", "down"),
        step(3.5, "Slowly bring the camera down to your shoes.", "tilt-down"),
        step(6.5, "Go round your shoes.", "orbit"),
        step(10, "Look left and right, as if you can't find the pen.", "left"),
        step(12, "Move the camera back up.", "up"),
      ],
      script: [],
    },
  ],
};

const TREE_TALK = {
  title: "One tip, by the tree",
  format: "Talking hook",
  summary: "Standing by a tree, a quick hook to camera, then the tip.",
  audio: "speech",
  durationSeconds: 24,
  shots: [
    {
      kind: "video",
      title: "The hook",
      purpose: "Grab attention in the first seconds.",
      sourceStartSeconds: 0,
      sourceEndSeconds: 6,
      durationSeconds: 6,
      camera: "front",
      scene: "Stand near a tree",
      sceneLandmark: "tree",
      framing: {
        shotSize: "medium",
        subject: { x: 0.22, y: 0.12, width: 0.56, height: 0.8 },
        note: "Waist up, the tree behind you.",
      },
      phoneAngle: eyeLevel,
      pose: { description: "Facing the camera, one hand raised.", keypoints: upperBody() },
      steps: [step(0, "Look straight into the lens."), step(3, "Lean in a little.", "forward")],
      script: [
        line(0, 2.6, "Stop scrolling for a second."),
        line(2.8, 5.8, "This one tip changed my mornings."),
      ],
    },
    {
      kind: "video",
      title: "The tip",
      purpose: "Deliver the tip, walking a step or two.",
      sourceStartSeconds: 6,
      sourceEndSeconds: 24,
      durationSeconds: 12,
      camera: "front",
      scene: "Stand near a tree",
      sceneLandmark: "tree",
      framing: {
        shotSize: "medium",
        subject: { x: 0.22, y: 0.12, width: 0.56, height: 0.8 },
        note: "Keep the tree in the background.",
      },
      phoneAngle: eyeLevel,
      pose: { description: "Relaxed, talking with your hands.", keypoints: upperBody() },
      steps: [
        step(0, "Start talking as you take a step.", "back"),
        step(8, "Stop and finish to camera."),
      ],
      script: [
        line(0, 3.5, "Put your phone in another room at night."),
        line(3.8, 7.5, "You'll sleep better and wake up without the scroll."),
        line(7.8, 11.5, "Try it for a week and tell me how it went."),
      ],
    },
  ],
};

const PLANS: Record<Template, object> = {
  grwm: GRWM,
  "pen-drop": PEN_DROP,
  "tree-talk": TREE_TALK,
};

export function planFor(template: Template): object {
  return PLANS[template];
}
