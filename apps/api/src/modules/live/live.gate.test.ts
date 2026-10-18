import { afterEach, describe, expect, it, vi } from "vitest";
import { type GateEvents, NoteGate, TURN_SILENT_MS, together } from "./live.gate";
import type { AppNote } from "./live.setup";

const noteOf = (text: string, answer = false): AppNote => ({
  clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: answer },
});

function gate(waiting = () => false) {
  const deliver = vi.fn<GateEvents["deliver"]>();
  const idle = vi.fn();
  return { deliver, idle, notes: new NoteGate({ waiting, idle, deliver }, () => 0) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the app's notes, around Director's turns", () => {
  it("go at once between turns", () => {
    const { deliver, notes } = gate();
    notes.send("camera", () => noteOf("[flipped]", true));
    expect(deliver).toHaveBeenCalledWith(noteOf("[flipped]", true), ["camera"], false);
    expect(notes.turnAge()).toBeNull();
  });

  it("wait for the turn, keep only the latest move and the newest few, then go as one", () => {
    vi.useFakeTimers();
    const { deliver, idle, notes } = gate();
    notes.turnGoesOn();
    for (let at = 0; at < 10; at += 1) {
      notes.send("restored", () => noteOf(`[restored ${at}]`));
    }
    notes.send("shot", () => noteOf("[shot 2]"));
    notes.send("shot", () => noteOf("[shot 3]", true));
    expect(deliver).not.toHaveBeenCalled();
    expect(notes.turnAge()).toBe(0);
    vi.advanceTimersByTime(TURN_SILENT_MS);
    expect(idle).toHaveBeenCalled();
    const [[note, kinds, held]] = deliver.mock.calls as [[AppNote, string[], boolean]];
    expect(held).toBe(true);
    expect(kinds).toEqual([...Array(7).fill("restored"), "shot"]);
    expect(note.clientContent.turnComplete).toBe(true);
    expect(note.clientContent.turns.map((turn) => turn.parts[0]?.text)).toEqual([
      "[restored 3]",
      "[restored 4]",
      "[restored 5]",
      "[restored 6]",
      "[restored 7]",
      "[restored 8]",
      "[restored 9]",
      "[shot 3]",
    ]);
  });

  it("wait while a tool call is pending, even once the turn is over, and go once it's answered", () => {
    let pending = true;
    const { deliver, notes } = gate(() => pending);
    notes.send("forgot", () => noteOf("[forgot]", true));
    notes.turnOver();
    expect(deliver).not.toHaveBeenCalled();
    pending = false;
    notes.release();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("are let go when the call ends", () => {
    vi.useFakeTimers();
    const { deliver, notes } = gate();
    notes.turnGoesOn();
    notes.send("quiet", () => noteOf("[quiet]", true));
    notes.stop();
    notes.turnOver();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("join into one turn that asks for an answer when any of them does", () => {
    expect(together([noteOf("a"), noteOf("b")]).clientContent.turnComplete).toBe(false);
    expect(together([noteOf("a"), noteOf("b", true)]).clientContent.turns).toHaveLength(2);
  });
});
