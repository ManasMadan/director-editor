import { Global, Inject, Module } from "@nestjs/common";
import { DATABASE, type Database, REDIS, type Redis } from "@repo/nest-common";
import { env } from "../env";
import { BillingModule, BillingService } from "../modules/billing";
import { CRITICAL_NOTIFICATIONS, type CriticalNotifications } from "../notifications";
import { type Auth, createAuth } from "./auth";
import { createMemberships, type Memberships } from "./memberships";

export const AUTH = Symbol("AUTH");
export const InjectAuth = () => Inject(AUTH);
export const MEMBERSHIPS = Symbol("MEMBERSHIPS");
export type { Auth, Memberships };

/** The better-auth instance, built from the service's own database, Redis and queues. */
@Global()
@Module({
  imports: [BillingModule],
  providers: [
    {
      provide: MEMBERSHIPS,
      inject: [DATABASE, REDIS],
      useFactory: (database: Database, redis: Redis) => createMemberships(database.write, redis),
    },
    {
      provide: AUTH,
      inject: [DATABASE, REDIS, CRITICAL_NOTIFICATIONS, MEMBERSHIPS, BillingService],
      useFactory: (
        database: Database,
        redis: Redis,
        notifications: CriticalNotifications,
        memberships: Memberships,
        billing: BillingService,
      ) => createAuth({ env, db: database.write, redis, notifications, memberships, billing }),
    },
  ],
  exports: [AUTH, MEMBERSHIPS],
})
export class AuthModule {}
