import { videoIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { chatTurnDetail } from "./chat-turn";

const base = {
  videoId: videoIdSchema.parse("dQw4w9WgXcQ"),
  shotIndex: 1,
  adaptations: [],
  recent: [],
  answers: [],
};

describe("a slower-line turn for analytics", () => {
  it("keeps what started it, the tools and the wait, never the words", () => {
    const detail = chatTurnDetail(
      { ...base, turn: { kind: "said", text: "I'm fine shooting inside" } },
      { reply: "Inside it is!", calls: [{ name: "go_to_shot", shot: 2 }] },
      1234.4,
    );
    expect(detail).toEqual({
      line: "chat",
      shot: 1,
      input: "said",
      latencyMs: 1234,
      tools: ["go_to_shot"],
      interrupted: false,
      spoke: true,
    });
    expect(JSON.stringify(detail)).not.toMatch(/inside/i);
  });

  it("names the app's own turns, and a reply with nothing to say", () => {
    expect(
      chatTurnDetail(
        { ...base, turn: { kind: "camera", facing: "back" } },
        { reply: " ", calls: [] },
        -5,
      ),
    ).toMatchObject({ input: "app:camera", latencyMs: 0, tools: [], spoke: false });
  });
});
