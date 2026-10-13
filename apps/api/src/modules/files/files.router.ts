/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { FilesService } from "./files.service";

export const filesRouter = ({ authed }: Procedures, files: FilesService) => ({
  createUpload: authed.files.createUpload.handler(({ context, input }) =>
    files.createUpload(context.user.id, input),
  ),
  completeUpload: authed.files.completeUpload.handler(({ context, input }) =>
    files.complete(context.user.id, input.fileId),
  ),
  get: authed.files.get.handler(({ context, input }) => files.get(context.user.id, input.fileId)),
});
