/**
 * The API contract: every procedure, its route, input, output and errors. The server
 * implements it (apps/api), clients call it (packages/client), and the OpenAPI document
 * for third parties is generated from it. Changing anything here is an API change:
 * CI compares the generated OpenAPI document against master and fails on breaking
 * changes (removed fields, new required inputs), which also protects older mobile apps.
 */
import { populateContractRouterPaths } from "@orpc/contract";
import { apiKeysContract } from "./api-keys";
import { auditContract } from "./audit";
import { billingContract } from "./billing";
import { directorContract } from "./director";
import { filesContract } from "./files";
import { notificationsContract } from "./notifications";
import { realtimeContract } from "./realtime";
import { shortsContract } from "./shorts";
import { systemContract } from "./system";
import { todoContract } from "./todo";
import { userContract } from "./user";
import { webhooksContract } from "./webhooks";

export const contract = populateContractRouterPaths({
  system: systemContract,
  user: userContract,
  apiKeys: apiKeysContract,
  todo: todoContract,
  audit: auditContract,
  webhooks: webhooksContract,
  realtime: realtimeContract,
  notifications: notificationsContract,
  files: filesContract,
  billing: billingContract,
  shorts: shortsContract,
  director: directorContract,
});

export type Contract = typeof contract;

export * from "./api-keys";
export * from "./audit";
export * from "./base";
export * from "./billing";
export * from "./director";
export * from "./files";
export * from "./notifications";
export * from "./realtime";
export * from "./scopes";
export * from "./shorts";
export * from "./system";
export * from "./todo";
export * from "./user";
export * from "./webhooks";
