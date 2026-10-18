/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { RecordingService } from "./recording.service";

export const recordingRouter = ({ inOrg }: Procedures, recording: RecordingService) => ({
  start: inOrg.recording.start.handler(({ context, input }) =>
    recording.start(context, input.videoId),
  ),
  sessions: inOrg.recording.sessions.handler(({ context }) => recording.sessions(context)),
  session: inOrg.recording.session.handler(({ context, input }) =>
    recording.session(context, input.sessionId),
  ),
  addPart: inOrg.recording.addPart.handler(({ context, input }) =>
    recording.addPart(context, input),
  ),
  closePart: inOrg.recording.closePart.handler(({ context, input }) =>
    recording.closePart(context, input),
  ),
  uploadSlice: inOrg.recording.uploadSlice.handler(({ context, input }) =>
    recording.uploadSlice(context, input),
  ),
  completeSlice: inOrg.recording.completeSlice.handler(({ context, input }) =>
    recording.completeSlice(context, input),
  ),
  mark: inOrg.recording.mark.handler(({ context, input }) => recording.mark(context, input)),
  pause: inOrg.recording.pause.handler(({ context, input }) => recording.pause(context, input)),
  resume: inOrg.recording.resume.handler(({ context, input }) => recording.resume(context, input)),
  finish: inOrg.recording.finish.handler(({ context, input }) =>
    recording.finish(context, input.sessionId),
  ),
  remove: inOrg.recording.remove.handler(({ context, input }) =>
    recording.remove(context, input.sessionId),
  ),
});
