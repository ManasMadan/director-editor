/**
 * Director's own voice on the shoot screen (Gemini's, through `director.speak`), against
 * the API implemented in memory: one ask per line, a fresh link before the old one runs
 * out, a rest after a failure, and no more asking once the API says the voice is off.
 */
import { MINUTE_MS } from "@repo/contracts/time";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDirectorVoice } from "@/modules/director/hooks/use-director-voice";
import { renderHook, standIn } from "./support";

afterEach(() => {
  vi.useRealTimers();
});

const link = (text: string) => `https://files.example.com/speech/${encodeURIComponent(text)}.wav`;

/** The API's `director.speak`, each answer's link living `livesFor`, or refusing with `refusal`. */
function speechApi({
  livesFor = 60 * MINUTE_MS,
  refusal,
}: {
  livesFor?: number;
  refusal?: "FEATURE_DISABLED" | "UPSTREAM_UNAVAILABLE";
} = {}) {
  const asked: { text: string; voice: string }[] = [];
  const api = standIn((os) => ({
    director: {
      speak: os.director.speak.handler(({ input, errors }) => {
        asked.push(input);
        if (refusal) {
          throw errors[refusal]({ data: { params: {} } });
        }
        return { url: link(input.text), expiresAt: new Date(Date.now() + livesFor) };
      }),
    },
  }));
  return { api, asked };
}

describe("useDirectorVoice", () => {
  it("asks for each line once, in Director's voice, and keeps its link", async () => {
    const { api, asked } = speechApi();
    const hook = await renderHook(() => useDirectorVoice(), { api });
    await expect(hook.current("Step back.")).resolves.toBe(link("Step back."));
    await expect(hook.current("Step back.")).resolves.toBe(link("Step back."));
    await expect(hook.current("Action!")).resolves.toBe(link("Action!"));
    expect(asked).toEqual([
      { text: "Step back.", voice: "Puck" },
      { text: "Action!", voice: "Puck" },
    ]);
  });

  it("asks again for a line whose link is about to run out", async () => {
    const { api, asked } = speechApi({ livesFor: 10_000 });
    const hook = await renderHook(() => useDirectorVoice(), { api });
    await hook.current("Cut!");
    await hook.current("Cut!");
    expect(asked).toHaveLength(2);
  });

  it("stops asking once the API says Director's voice is off", async () => {
    const { api, asked } = speechApi({ refusal: "FEATURE_DISABLED" });
    const hook = await renderHook(() => useDirectorVoice(), { api });
    await expect(hook.current("One")).rejects.toThrow();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * MINUTE_MS);
    await expect(hook.current("Two")).rejects.toThrow();
    expect(asked).toHaveLength(1);
  });

  it("rests for a minute after a failure that may pass, then asks again", async () => {
    const { api, asked } = speechApi({ refusal: "UPSTREAM_UNAVAILABLE" });
    const hook = await renderHook(() => useDirectorVoice(), { api });
    await expect(hook.current("One")).rejects.toThrow();
    await expect(hook.current("Two")).rejects.toThrow();
    expect(asked).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MINUTE_MS);
    await expect(hook.current("Two")).rejects.toThrow();
    expect(asked).toHaveLength(2);
  });
});
