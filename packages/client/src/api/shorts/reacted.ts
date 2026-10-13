/** The member's reactions after turning one on or off: what the screen shows at once. */
import type { ShortReactionKind, ShortReactions } from "@repo/contracts/api";

export function reacted(
  current: ShortReactions | undefined,
  kind: ShortReactionKind,
  on: boolean,
): ShortReactions {
  const base = current ?? { liked: false, saved: false };
  return kind === "like" ? { ...base, liked: on } : { ...base, saved: on };
}
