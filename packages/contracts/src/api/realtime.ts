import { eventIterator } from "@orpc/contract";
import { realtimeMessage } from "../realtime";
import { base, errorsOf, WORKSPACE_ERRORS } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(...WORKSPACE_ERRORS);

export const realtimeContract = {
  /**
   * A stream of change notifications for the signed-in user and their active workspace.
   * It ends after a while (the client reconnects, re-checking the session), and when the
   * workspace is switched the client opens a new one.
   */
  subscribe: base
    .errors(errors)
    .route({
      method: "GET",
      path: "/realtime",
      tags: ["Realtime"],
      summary: "Live change notifications (SSE)",
    })
    .output(eventIterator(realtimeMessage)),
};
