import { describe, expect, it } from "vitest";
import { type Body, bodyFromLandmarks, LANDMARK_INDEX, poseScore, targetBody } from "./pose";

const standing: Body = {
  nose: { x: 0.5, y: 0.1 },
  left_shoulder: { x: 0.6, y: 0.25 },
  right_shoulder: { x: 0.4, y: 0.25 },
  left_hip: { x: 0.57, y: 0.55 },
  right_hip: { x: 0.43, y: 0.55 },
  left_ankle: { x: 0.58, y: 0.95 },
  right_ankle: { x: 0.42, y: 0.95 },
};

/** The same body, moved and scaled. */
function moved(body: Body, dx: number, scale: number): Body {
  return Object.fromEntries(
    Object.entries(body).map(([name, p]) => [name, { x: p.x * scale + dx, y: p.y * scale }]),
  );
}

describe("bodies", () => {
  it("picks the plan's joints out of MediaPipe's landmarks, if it can see them", () => {
    const landmarks = Array.from({ length: 33 }, (_, i) => ({
      x: i / 33,
      y: 0.5,
      visibility: 0.9,
    }));
    landmarks[LANDMARK_INDEX.left_knee] = { x: 0.1, y: 0.1, visibility: 0.2 };
    const body = bodyFromLandmarks(landmarks);
    expect(body.nose).toEqual({ x: 0, y: 0.5 });
    expect(body.right_wrist).toEqual({ x: 16 / 33, y: 0.5 });
    expect(body.left_knee).toBeUndefined();
    expect(bodyFromLandmarks([{ x: 0.5, y: 0.5 }]).nose).toEqual({ x: 0.5, y: 0.5 });
  });

  it("reads the plan's target pose", () => {
    expect(
      targetBody({ description: "Hands up", keypoints: [{ name: "nose", x: 0.5, y: 0.2 }] }),
    ).toEqual({
      nose: { x: 0.5, y: 0.2 },
    });
  });

  it("scores the shape of a pose, wherever and however large it is", () => {
    expect(poseScore(standing, moved(standing, 0.2, 0.6))).toBeCloseTo(1);
    const armsUp: Body = {
      ...standing,
      left_shoulder: { x: 0.9, y: 0.0 },
      right_ankle: { x: 0.1, y: 0.5 },
    };
    const score = poseScore(standing, armsUp);
    expect(score).not.toBeNull();
    expect(score ?? 1).toBeLessThan(0.75);
  });

  it("won't judge with too few joints in common", () => {
    expect(poseScore(standing, { nose: { x: 0.5, y: 0.1 } })).toBeNull();
  });

  it("handles every joint in one place", () => {
    const dot: Body = Object.fromEntries(
      Object.keys(standing).map((name) => [name, { x: 0.5, y: 0.5 }]),
    );
    expect(poseScore(dot, dot)).toBe(1);
  });
});
