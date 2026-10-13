import { describe, expect, it, vi } from "vitest";
import { embedUrl, sendCommand, shortUrl } from "./embed";

describe("YouTube's embed", () => {
  it("plays inline from YouTube's privacy-enhanced domain, muted when asked", () => {
    const url = new URL(embedUrl("jNQXAC9IVRw", { autoplay: true, muted: true }));
    expect(url.origin).toBe("https://www.youtube-nocookie.com");
    expect(url.pathname).toBe("/embed/jNQXAC9IVRw");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      autoplay: "1",
      mute: "1",
      playsinline: "1",
      controls: "0",
    });
  });

  it("loops one video as its own playlist, and plays just a part", () => {
    const url = new URL(
      embedUrl("jNQXAC9IVRw", { loop: true, startSeconds: 3.7, endSeconds: 6.2, controls: true }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      loop: "1",
      playlist: "jNQXAC9IVRw",
      start: "3",
      end: "7",
      controls: "1",
      autoplay: "0",
    });
  });

  it("links to the short on YouTube", () => {
    expect(shortUrl("jNQXAC9IVRw")).toBe("https://www.youtube.com/shorts/jNQXAC9IVRw");
  });

  it("sends the player its commands, to YouTube's origin only", () => {
    const postMessage = vi.fn();
    sendCommand({ contentWindow: { postMessage } } as unknown as HTMLIFrameElement, "unMute");
    expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ event: "command", func: "unMute", args: [] }),
      "https://www.youtube-nocookie.com",
    );
  });

  it("sends nothing before the player is there", () => {
    expect(() => sendCommand(null, "mute")).not.toThrow();
    expect(() => sendCommand({ contentWindow: null } as HTMLIFrameElement, "mute")).not.toThrow();
  });
});
