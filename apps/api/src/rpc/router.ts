/**
 * The full API router. `os.router` checks it against the contract: a procedure that is
 * in packages/contracts but not implemented here (or vice versa) is a compile error.
 *
 * To add a feature: define its procedures in packages/contracts/src/api, write a module
 * under src/modules/<feature> (module, service, repository, router), register the module
 * in app.module.ts and its router below.
 */
import type { INestApplicationContext } from "@nestjs/common";
import { AiService, aiRouter } from "../modules/ai";
import { ApiKeysService, apiKeysRouter } from "../modules/api-keys";
import { AppsService, appsRouter } from "../modules/apps";
import { AuditService, auditRouter } from "../modules/audit";
import { BillingService, billingRouter } from "../modules/billing";
import { FilesService, filesRouter } from "../modules/files";
import { NotificationsService, notificationsRouter } from "../modules/notifications";
import { RealtimeService, realtimeRouter } from "../modules/realtime";
import { systemRouter } from "../modules/system";
import { TodoService, todoRouter } from "../modules/todo";
import { AvatarService, PhoneService, userRouter } from "../modules/user";
import { WebhooksService, webhooksRouter } from "../modules/webhooks";
import type { Procedures } from "./procedures";

export function createRouter(procedures: Procedures, app: INestApplicationContext) {
  return procedures.os.router({
    system: systemRouter(procedures),
    user: userRouter(procedures, app.get(PhoneService), app.get(AvatarService)),
    apps: appsRouter(procedures, app.get(AppsService)),
    apiKeys: apiKeysRouter(procedures, app.get(ApiKeysService)),
    todo: todoRouter(procedures, app.get(TodoService)),
    ai: aiRouter(procedures, app.get(AiService)),
    audit: auditRouter(procedures, app.get(AuditService)),
    webhooks: webhooksRouter(procedures, app.get(WebhooksService)),
    realtime: realtimeRouter(procedures, app.get(RealtimeService)),
    notifications: notificationsRouter(procedures, app.get(NotificationsService)),
    files: filesRouter(procedures, app.get(FilesService)),
    billing: billingRouter(procedures, app.get(BillingService)),
  });
}

export type AppRouter = ReturnType<typeof createRouter>;
