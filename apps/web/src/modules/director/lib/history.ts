/** Undo and redo for the editor's choices: the states before, the one now, those undone. */

export interface History<T> {
  past: T[];
  now: T;
  future: T[];
}

export const historyOf = <T>(now: T): History<T> => ({ past: [], now, future: [] });

/** A new state: it can be undone, and what was undone can't be redone any more. */
export function push<T>(history: History<T>, next: T): History<T> {
  return { past: [...history.past, history.now], now: next, future: [] };
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) {
    return history;
  }
  return {
    past: history.past.slice(0, -1),
    now: previous,
    future: [history.now, ...history.future],
  };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) {
    return history;
  }
  return { past: [...history.past, history.now], now: next, future: rest };
}
