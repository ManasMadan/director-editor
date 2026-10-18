import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWERED_FOR_MS, createCaptionStore } from "./caption-store";

const texts = (store: ReturnType<typeof createCaptionStore>) =>
  store.get().captions.lines.map(({ who, text, done }) => `${who}:${text}${done ? "." : ""}`);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Director live's captions", () => {
  it("show Director's words as its voice reaches them, in order, the member's under them", () => {
    const store = createCaptionStore(() => Date.now());
    const heard = vi.fn();
    const unsubscribe = store.subscribe(heard);
    store.said("director", "Hi! ", 0);
    store.said("director", "Step back.", 300);
    // Sooner than the words before it: still after them, and the member's after those.
    store.said("director", " More.", 100);
    store.said("you", "Like this?");
    expect(texts(store)).toEqual(["director:Hi! "]);
    vi.advanceTimersByTime(300);
    expect(texts(store)).toEqual(["director:Hi! Step back. More..", "you:Like this?"]);
    store.said("director", "Yes!");
    // Its line is done once its voice has played.
    store.turnOver(1000);
    expect(texts(store)).toEqual(["you:Like this?.", "director:Yes!"]);
    vi.advanceTimersByTime(1000);
    expect(texts(store)).toEqual(["you:Like this?.", "director:Yes!."]);
    expect(heard).toHaveBeenCalled();
    unsubscribe();
  });

  it("drop the words Director never said when the member cuts in, and end its line", () => {
    const store = createCaptionStore(() => Date.now());
    store.said("director", "Hold it ", 0);
    store.said("director", "right there and", 500);
    store.said("you", "wait");
    store.cut();
    vi.advanceTimersByTime(1000);
    // What the member said stays: it's their cutting in.
    expect(texts(store)).toEqual(["director:Hold it .", "you:wait"]);
  });

  it("let the member's line go a while after Director has answered it, or when they act", () => {
    const store = createCaptionStore(() => Date.now());
    store.typed("ready?");
    store.said("director", "Go!");
    store.turnOver();
    expect(texts(store)).toEqual(["you:ready?.", "director:Go!."]);
    vi.advanceTimersByTime(ANSWERED_FOR_MS);
    expect(texts(store)).toEqual(["director:Go!."]);
    store.typed("again");
    store.withoutMember();
    expect(texts(store)).toEqual(["director:Go!."]);
  });

  it("say what Director is busy with, and start over clean", () => {
    const store = createCaptionStore(() => Date.now());
    store.working("replanning");
    store.working("replanning");
    expect(store.get().working).toBe("replanning");
    store.said("director", "One sec", 200);
    store.clear();
    vi.advanceTimersByTime(500);
    expect(store.get()).toEqual({ captions: { lines: [], key: 0 }, working: null });
    store.said("director", "Later", 200);
    store.stop();
    vi.advanceTimersByTime(500);
    expect(texts(store)).toEqual([]);
  });

  it("read the page's clock by default", () => {
    const store = createCaptionStore();
    store.said("director", "Hi", 0);
    expect(texts(store)).toEqual(["director:Hi"]);
  });
});
