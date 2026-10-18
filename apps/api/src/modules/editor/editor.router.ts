/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { EditorService } from "./editor.service";

export const editorRouter = ({ inOrg }: Procedures, editor: EditorService) => ({
  ask: inOrg.editor.ask.handler(({ context, input }) =>
    editor.ask(context.userId, context.orgId, input),
  ),
});
