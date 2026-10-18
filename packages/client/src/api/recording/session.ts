/**
 * A recording session with its parts and attempts, followed while attempts are being cut
 * into takes (a `recording.changed` nudge refetches it at once; the poll covers a missed
 * one). A reopened shoot screen reads which slices are stored from it.
 */
import type { RecordingSession, RecordingSessionDetail } from "@repo/contracts/api";
import type { RecordingSessionId } from "@repo/contracts/ids";
import { RECORDING_WARN_MS } from "@repo/contracts/recording";
import { SECOND_MS } from "@repo/contracts/time";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useApi } from "../../provider";

/** Whether any of the session's ended attempts is still on its way to being a take. */
export function attemptsInProgress(session: RecordingSessionDetail | undefined) {
  return (
    session?.attempts.some(
      (attempt) => attempt.status === "waiting" || attempt.status === "clipping",
    ) ?? false
  );
}

/** Past the 17 minutes after which the shoot screen warns that the 20 are nearly up. */
export function nearRecordingLimit(session: RecordingSession) {
  return session.recordedMs >= RECORDING_WARN_MS;
}

export function useRecordingSessionQuery(sessionId: RecordingSessionId | null) {
  const { api } = useApi();
  return useQuery(
    api.recording.session.queryOptions({
      // Nothing to ask while there's no session yet.
      input: sessionId === null ? skipToken : { sessionId },
      refetchInterval: (query) => (attemptsInProgress(query.state.data) ? 5 * SECOND_MS : false),
    }),
  );
}
