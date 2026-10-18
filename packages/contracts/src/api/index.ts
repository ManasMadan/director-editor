/**
 * The API contract: every procedure, its route, input, output and errors. The server
 * implements it (apps/api), clients call it (packages/client), and the OpenAPI document
 * for third parties is generated from it. Changing anything here is an API change:
 * CI compares the generated OpenAPI document against master and fails on breaking
 * changes (removed fields, new required inputs), which also protects older mobile apps.
 */
import { populateContractRouterPaths } from "@orpc/contract";
import { directorContract } from "./director";
import { filesContract } from "./files";
import { realtimeContract } from "./realtime";
import { systemContract } from "./system";
import { userContract } from "./user";

export const contract = populateContractRouterPaths({
  system: systemContract,
  user: userContract,
  realtime: realtimeContract,
  files: filesContract,
  director: directorContract,
});

export type Contract = typeof contract;

export * from "./base";
export * from "./director";
export * from "./files";
export * from "./realtime";
export * from "./system";
export * from "./user";
