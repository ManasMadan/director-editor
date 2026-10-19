import { beforeAll, describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "@/lib/csp";
import { posterPicture } from "@/modules/director/lib/visuals";
import { canvasOf, photoOf } from "./footage";

// This page is held to the site's own rules for what it may load (the proxy's policy),
// except for scripts and styles, which the test runner itself needs. A test page has no
// policy of its own, so without this, code the site blocks would pass here.
beforeAll(() => {
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = contentSecurityPolicy({
    nonce: "test",
    development: false,
    storageOrigin: undefined,
  })
    .filter((directive) => /^(connect|img|media)-src /.test(directive))
    .join("; ");
  document.head.append(meta);
});

describe("the editor under the site's Content-Security-Policy", () => {
  it("reads a take's card frame from its data: or blob: URL", async () => {
    const { canvas, ctx } = canvasOf(90, 160);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 90, 160);
    const data = canvas.toDataURL("image/jpeg");
    const blob = URL.createObjectURL(await photoOf("#00ff00"));
    // The policy is on: fetching either URL is refused, as on the site.
    await expect(fetch(data)).rejects.toThrow();
    await expect(fetch(blob)).rejects.toThrow();
    for (const url of [data, blob]) {
      const picture = await posterPicture(url);
      expect([picture.width, picture.height]).toEqual([90, 160]);
    }
  });
});
