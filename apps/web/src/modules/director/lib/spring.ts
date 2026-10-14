/**
 * Smooth motion for what the doodles track (the member's feet, the landmark Gemini saw,
 * the things the object detector finds). Detections arrive a few times a second and
 * wobble by a few pixels each time; drawn as they come, the doodles would jump and
 * shiver. Each tracked value instead glides to its latest reading on a critically damped
 * spring: no overshoot, no jitter, and steady at any frame rate.
 */

/** How long a glide takes to settle, roughly, in seconds. */
const GLIDE_SECONDS = 0.18;
/** A value not read again for this long is forgotten, so a thing seen again snaps in. */
const FORGET_SECONDS = 1;

interface Spring {
  value: number;
  velocity: number;
}

/**
 * One step of a critically damped spring from `current` towards `target` over `dt`
 * seconds (the closed form game engines call SmoothDamp, stable for any step).
 */
export function damp(current: Spring, target: number, dt: number, settle = GLIDE_SECONDS): Spring {
  const omega = 2 / settle;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current.value - target;
  const temp = (current.velocity + omega * change) * dt;
  return {
    value: target + (change + temp) * decay,
    velocity: (current.velocity - omega * temp) * decay,
  };
}

/** Springs by name: each `glide` moves a named group of numbers towards new targets. */
export class Glider {
  private readonly springs = new Map<string, { springs: Spring[]; seen: number }>();
  private last: number | null = null;
  private dt = 0;

  /** Starts a frame at `now` (seconds); forgets what wasn't seen for a while. */
  frame(now: number) {
    // A long gap (a hidden tab) is one short step, not a leap.
    this.dt = this.last === null ? 0 : Math.min(0.1, Math.max(0, now - this.last));
    this.last = now;
    for (const [key, entry] of this.springs) {
      if (now - entry.seen > FORGET_SECONDS) {
        this.springs.delete(key);
      }
    }
  }

  /** `targets` smoothed under `key`; a new key starts where its targets are. */
  glide(key: string, targets: readonly number[]): number[] {
    const now = this.last ?? 0;
    const entry = this.springs.get(key);
    if (!entry || entry.springs.length !== targets.length) {
      this.springs.set(key, {
        springs: targets.map((value) => ({ value, velocity: 0 })),
        seen: now,
      });
      return [...targets];
    }
    entry.seen = now;
    entry.springs = entry.springs.map((spring, index) =>
      damp(spring, targets[index] ?? spring.value, this.dt),
    );
    return entry.springs.map((spring) => spring.value);
  }
}
