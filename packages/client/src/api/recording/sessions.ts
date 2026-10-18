/**
 * The member's recording sessions whose footage is still kept, newest first: what the
 * shoot screen offers to delete when the footage allowance is full.
 */
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

export function useRecordingSessionsQuery() {
  const { api } = useApi();
  return useQuery(api.recording.sessions.queryOptions());
}
