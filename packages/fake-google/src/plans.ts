/**
 * The shot plans the fake Gemini writes, one per kind of short, in the shape Director asks
 * for (apps/ai/app/schemas.py ShotPlan). They follow the Director PRD's examples: a GRWM in
 * six shots (four videos, two photos) with speech, and the pen-drop shoe flaunt in one
 * back-camera video; and the "stand near a tree" talk the PRD's scene example uses. The
 * office GRWM is the one plan written from a real short (the catalog's first): its shots
 * follow that video's own cuts, so the demo's plan matches what the player shows.
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

// The office GRWM is filmed on a phone propped up at waist height, screen facing the
// member so they can watch the guides, and moved closer for the detail shots.
const propped = { pitch: 0, roll: 0, tolerance: 8, height: "waist" };
const sameSpot = "Same spot, phone where it was";

/**
 * "GRWM for the office in summer time!" (YouTube HasaZYkwYds): its 13 cuts, with the tuck
 * and the side adjusters (one waist close-up, then the same from the side) as one shot to
 * stay within twelve. The sound is a song with no one speaking, so there's no script.
 */
const OFFICE_GRWM = {
  title: "GRWM for the office",
  format: "GRWM",
  summary:
    "A work outfit built piece by piece in front of a propped-up phone: trousers, shirt, watch, sleeves, loafers and fragrance, then the full look. Quick cuts on the beat, no talking.",
  audio: "music",
  durationSeconds: 26.1,
  shots: [
    {
      kind: "video",
      title: "The trousers",
      purpose: "The opener: the first piece goes on, full body, with room for the title.",
      sourceStartSeconds: 0,
      sourceEndSeconds: 4.4,
      durationSeconds: 4.4,
      camera: "front",
      scene: "A plain wall with a mirror beside you",
      sceneLandmark: "mirror",
      framing: {
        shotSize: "full-body",
        subject: { x: 0.24, y: 0.2, width: 0.46, height: 0.76 },
        note: "Head to toe, space above you for the title.",
      },
      phoneAngle: propped,
      pose: {
        description: "Standing square to the camera, trousers held at the waist.",
        keypoints: standing(0.2, 0.96),
      },
      steps: [
        step(0, "Stand tall in a tee, trousers in your hands."),
        step(0.5, "Step into them one leg at a time."),
        step(2.5, "Pull them up and do up the button."),
      ],
      script: [],
    },
    {
      kind: "video",
      title: "The shirt",
      purpose: "The second piece, held up to the lens, then swung on.",
      sourceStartSeconds: 4.4,
      sourceEndSeconds: 6.6,
      durationSeconds: 2.2,
      camera: "front",
      scene: "Same spot, phone a step closer",
      sceneLandmark: null,
      framing: {
        shotSize: "medium",
        subject: { x: 0.1, y: 0.1, width: 0.8, height: 0.88 },
        note: "Head to thighs, the shirt fills the frame.",
      },
      phoneAngle: { ...propped, height: "chest" },
      pose: { description: "Arms wide, the shirt held open.", keypoints: upperBody() },
      steps: [
        step(0, "Show your shirt to the camera on its hanger."),
        step(1, "Swing it on, one arm then the other."),
      ],
      script: [],
    },
    {
      kind: "video",
      title: "The buttons",
      purpose: "A closer look at the shirt coming together.",
      sourceStartSeconds: 6.6,
      sourceEndSeconds: 10.1,
      durationSeconds: 3.5,
      camera: "front",
      scene: sameSpot,
      sceneLandmark: null,
      framing: {
        shotSize: "medium",
        subject: { x: 0.05, y: 0.02, width: 0.9, height: 0.96 },
        note: "Chin to hips: your hands are the action.",
      },
      phoneAngle: { ...propped, height: "chest" },
      pose: { description: "Looking down at your hands.", keypoints: [] },
      steps: [
        step(0, "Look down and do the buttons, top to bottom."),
        step(2.5, "Leave the top button open."),
      ],
      script: [],
    },
    {
      kind: "video",
      title: "Tuck and adjust",
      purpose: "The details that make it sharp: the tuck and the side adjusters.",
      sourceStartSeconds: 10.1,
      sourceEndSeconds: 12.2,
      durationSeconds: 2.1,
      camera: "front",
      scene: sameSpot,
      sceneLandmark: null,
      framing: {
        shotSize: "close-up",
        subject: { x: 0.05, y: 0.25, width: 0.9, height: 0.75 },
        note: "Your waist in the middle of the frame.",
      },
      phoneAngle: propped,
      pose: { description: "Hands at your waistband.", keypoints: [] },
      steps: [
        step(0, "Tuck your shirt in and do up the fly."),
        step(1.3, "Turn a little and tighten the side tab."),
      ],
      script: [],
    },
    {
      kind: "photo",
      title: "The watch",
      purpose: "A product still: the watch sharp in front, you soft behind.",
      sourceStartSeconds: 12.2,
      sourceEndSeconds: 13.4,
      durationSeconds: 1.2,
      camera: "front",
      scene: sameSpot,
      sceneLandmark: null,
      framing: {
        shotSize: "close-up",
        subject: { x: 0.25, y: 0.4, width: 0.45, height: 0.45 },
        note: "The watch fills the middle; you're the blurred background.",
      },
      phoneAngle: { ...propped, height: "chest" },
      pose: { description: "Arm out, the watch held up to the lens.", keypoints: [] },
      steps: [step(0, "Hold your watch up close to the camera. Freeze!")],
      script: [],
    },
    {
      kind: "video",
      title: "Strap it on",
      purpose: "The watch going on, close.",
      sourceStartSeconds: 13.4,
      sourceEndSeconds: 15.6,
      durationSeconds: 2.2,
      camera: "front",
      scene: sameSpot,
      sceneLandmark: null,
      framing: {
        shotSize: "close-up",
        subject: { x: 0.05, y: 0.3, width: 0.85, height: 0.45 },
        note: "Your wrist in the middle, your face out of frame.",
      },
      phoneAngle: { ...propped, height: "chest" },
      pose: { description: "Wrist up at your chest.", keypoints: [] },
      steps: [
        step(0, "Bring your wrist up to your chest."),
        step(0.6, "Do up the strap and show the watch to the camera."),
      ],
      script: [],
    },
    {
      kind: "video",
      title: "The sleeves",
      purpose: "Back to full body: rolled sleeves make it summer.",
      sourceStartSeconds: 15.6,
      sourceEndSeconds: 19,
      durationSeconds: 3.4,
      camera: "front",
      scene: "Back at the first spot, phone back too",
      sceneLandmark: null,
      framing: { shotSize: "full-body", subject: fullBody, note: "Head to toe." },
      phoneAngle: propped,
      pose: {
        description: "Standing, rolling a sleeve, eyes on your arm.",
        keypoints: standing(0.06, 0.96),
      },
      steps: [
        step(0, "Roll one sleeve up twice, to below the elbow."),
        step(1.9, "Then the other."),
      ],
      script: [],
    },
    {
      kind: "video",
      title: "The loafers",
      purpose: "Show the shoes before they go on.",
      sourceStartSeconds: 19,
      sourceEndSeconds: 20.3,
      durationSeconds: 1.3,
      camera: "front",
      scene: sameSpot,
      sceneLandmark: null,
      framing: {
        shotSize: "close-up",
        subject: { x: 0.15, y: 0.2, width: 0.65, height: 0.5 },
        note: "The shoe fills the top half.",
      },
      phoneAngle: propped,
      pose: { description: "One loafer held out to the lens.", keypoints: [] },
      steps: [
        step(0, "Show one shoe to the camera."),
        step(0.5, "Turn it over to show the bottom."),
      ],
      script: [],
    },
    {
      kind: "video",
      title: "Slip them on",
      purpose: "Half a second on the beat: the quick cut that keeps the pace.",
      sourceStartSeconds: 20.3,
      sourceEndSeconds: 20.8,
      durationSeconds: 0.5,
      camera: "front",
      scene: sameSpot,
      sceneLandmark: null,
      framing: {
        shotSize: "full-body",
        subject: { x: 0.45, y: 0.4, width: 0.45, height: 0.58 },
        note: "Whole body, a little to one side.",
      },
      phoneAngle: propped,
      pose: { description: "Bent over, slipping a loafer on.", keypoints: [] },
      steps: [step(0, "Slip your shoes on, quick as a wink!")],
      script: [],
    },
    {
      kind: "photo",
      title: "The fragrance",
      purpose: "A product still of the last touch.",
      sourceStartSeconds: 20.8,
      sourceEndSeconds: 21.9,
      durationSeconds: 1.1,
      camera: "front",
      scene: sameSpot,
      sceneLandmark: null,
      framing: {
        shotSize: "close-up",
        subject: { x: 0.02, y: 0.35, width: 0.45, height: 0.45 },
        note: "The bottle sharp at the front, off to one side.",
      },
      phoneAngle: { ...propped, height: "chest" },
      pose: { description: "Arm out, the bottle held up to the lens.", keypoints: [] },
      steps: [step(0, "Hold your perfume up to the camera, label out.")],
      script: [],
    },
    {
      kind: "video",
      title: "A spray",
      purpose: "The fragrance going on, full body.",
      sourceStartSeconds: 21.9,
      sourceEndSeconds: 23.7,
      durationSeconds: 1.8,
      camera: "front",
      scene: sameSpot,
      sceneLandmark: null,
      framing: { shotSize: "full-body", subject: fullBody, note: "Head to toe." },
      phoneAngle: propped,
      pose: {
        description: "Head turned to one side, spraying your neck.",
        keypoints: standing(0.08, 0.96),
      },
      steps: [
        step(0, "Turn your head to one side."),
        step(0.4, "Spray your neck, then your wrist."),
      ],
      script: [],
    },
    {
      kind: "video",
      title: "The full look",
      purpose: "The payoff: the whole outfit, then walk out of frame.",
      sourceStartSeconds: 23.7,
      sourceEndSeconds: 26.1,
      durationSeconds: 2.4,
      camera: "front",
      scene: "Same spot, a step further back",
      sceneLandmark: null,
      framing: {
        shotSize: "full-body",
        subject: { x: 0.28, y: 0.14, width: 0.44, height: 0.84 },
        note: "Head to toe, a little smaller in frame.",
      },
      phoneAngle: propped,
      pose: {
        description: "One hand in your pocket, weight on one leg.",
        keypoints: standing(0.14, 0.98),
      },
      steps: [
        step(0, "Hand in your pocket, and smile at the camera!"),
        step(1.8, "Now walk away, like you're off to work!"),
      ],
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
  "office-grwm": OFFICE_GRWM,
  "pen-drop": PEN_DROP,
  "tree-talk": TREE_TALK,
};

export function planFor(template: Template): object {
  return PLANS[template];
}
