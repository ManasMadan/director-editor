import { describe, expect, it } from "vitest";
import { renderHtml } from "../../../../test/next-server";
import { XRAY } from "../lib/seeds";
import { Phone } from "./xray";

describe("the x-ray's phone", () => {
  const first = XRAY.firstShot;

  it("draws the first shot's lines, head and joints", async () => {
    const html = await renderHtml(await Phone({ shot: first, shots: 10 }));
    expect(html).toContain("Shot 1 of 10");
    expect(html).toContain("<circle");
    expect(html).toContain("Medium shot");
    expect(html).toContain("Hold the phone at eye level");
  });

  it("leaves out the lines and the head for a silent shot whose face isn't in the pose", async () => {
    const silent = {
      ...first,
      script: [],
      pose: { ...first.pose, keypoints: first.pose.keypoints.filter((p) => p.name !== "nose") },
    };
    const html = await renderHtml(await Phone({ shot: silent, shots: 10 }));
    expect(html).not.toContain(first.script[0]?.text.slice(0, 20));
    expect(html).not.toContain('r="7"');
  });
});
