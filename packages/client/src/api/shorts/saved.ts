/** The member's liked or saved shorts, newest first. */
import type { ShortReactionKind } from "@repo/contracts/api";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useSavedShortsQuery(kind: ShortReactionKind) {
  const { api } = useApi();
  return useQuery(api.shorts.saved.queryOptions({ input: { kind } }));
}
