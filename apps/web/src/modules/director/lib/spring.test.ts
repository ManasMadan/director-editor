import { describe, expect, it } from "vitest";
import { damp, Glider } from "./spring";

describe("springs", () => {
  it("settles on the target without overshooting it", () => {
    let spring = { value: 0, velocity: 0 };
    let highest = 0;
    for (let step = 0; step < 120; step += 1) {
      spring = damp(spring, 1, 1 / 60);
      highest = Math.max(highest, spring.value);
    }
    expect(spring.value).toBeCloseTo(1, 3);
    expect(highest).toBeLessThanOrEqual(1);
  });

  it("starts a new value where it is, then glides it to each new reading", () => {
    const glider = new Glider();
    glider.frame(0);
    expect(glider.glide("feet", [0.2, 0.8])).toEqual([0.2, 0.8]);
    glider.frame(1 / 30);
    const [x] = glider.glide("feet", [0.6, 0.8]);
    expect(x).toBeGreaterThan(0.2);
    expect(x).toBeLessThan(0.6);
  });

  it("forgets what isn't seen for a second, so it snaps in when it's back", () => {
    const glider = new Glider();
    glider.frame(0);
    glider.glide("cup", [0.1]);
    glider.frame(2);
    expect(glider.glide("cup", [0.9])).toEqual([0.9]);
  });

  it("starts over when a value's shape changes, and keeps a missing target where it was", () => {
    const glider = new Glider();
    glider.frame(0);
    glider.glide("box", [0.1, 0.1]);
    expect(glider.glide("box", [0.5, 0.5, 0.2, 0.2])).toEqual([0.5, 0.5, 0.2, 0.2]);
    glider.frame(0.05);
    const sparse: number[] = [0.5];
    sparse.length = 4;
    expect(glider.glide("box", sparse)[3]).toBeCloseTo(0.2);
  });

  it("starts a value where it is, even before the first frame", () => {
    expect(new Glider().glide("early", [0.4])).toEqual([0.4]);
  });
});
