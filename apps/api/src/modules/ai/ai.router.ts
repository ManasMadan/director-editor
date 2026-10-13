/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { AiService } from "./ai.service";

export const aiRouter = ({ inOrg }: Procedures, ai: AiService) => ({
  sentiment: inOrg.ai.sentiment.handler(({ context, input }) =>
    ai.sentiment(context.userId, context.orgId, input.text),
  ),
  documents: inOrg.ai.documents.handler(({ context }) =>
    ai.documents(context.userId, context.orgId),
  ),
  addDocument: inOrg.ai.addDocument.handler(({ context, input }) =>
    ai.addDocument(context.userId, context.orgId, input),
  ),
  removeDocument: inOrg.ai.removeDocument.handler(({ context, input }) =>
    ai.removeDocument(context.userId, context.orgId, context.role, input.documentId),
  ),
  ask: inOrg.ai.ask.handler(({ context, input, signal }) =>
    ai.ask(context.userId, context.orgId, input.question, signal),
  ),
});
