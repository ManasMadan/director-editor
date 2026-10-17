/**
 * How much of something a call may send over a sliding window: microphone bytes, typed
 * turns. Everything the browser forwards costs Gemini tokens, so a client that sends
 * faster than a person could speak or type is cut off rather than paid for.
 */
export class SlidingBudget {
  private readonly spent: { at: number; amount: number }[] = [];
  private total = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** Spends `amount` now, or answers false when that would go past the window's limit. */
  spend(amount: number): boolean {
    const now = this.now();
    for (let oldest = this.spent[0]; oldest && oldest.at <= now - this.windowMs; ) {
      this.spent.shift();
      this.total -= oldest.amount;
      oldest = this.spent[0];
    }
    if (this.total + amount > this.limit) {
      return false;
    }
    this.spent.push({ at: now, amount });
    this.total += amount;
    return true;
  }
}
