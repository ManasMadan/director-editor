/** Thin adapters from the contract to the service; no business logic lives here. */
import type { Procedures } from "../../rpc/procedures";
import type { AuditService } from "./audit.service";

export const auditRouter = ({ orgAdmin }: Procedures, audit: AuditService) => ({
  list: orgAdmin.audit.list.handler(({ context, input }) => audit.list(context.orgId, input)),
});
