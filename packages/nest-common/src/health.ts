/**
 * Kubernetes-style health endpoints for every service.
 *
 * - GET /health/live          the process is up (restart the pod if this fails)
 * - GET /health/ready         it serves requests (route traffic to it)
 * - GET /health/dependencies  each dependency it registered (Postgres, Redis, ...) answers
 *
 * Readiness doesn't check the dependencies: they're shared, so a Valkey restart would
 * mark every pod unready at once and the whole site would answer the gateway's 503
 * instead of the app's own errors. /health/dependencies is for dashboards, alerts and
 * start-up scripts that must wait for them (scripts/e2e.ts).
 */
import { Controller, type DynamicModule, Get, Inject, Module, Optional } from "@nestjs/common";
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  TerminusModule,
} from "@nestjs/terminus";
import type { Database } from "@repo/db";
import type { Redis } from "ioredis";
import { DATABASE } from "./database";
import { asError } from "./job-processor";
import { REDIS } from "./redis";

export type Dependency = "db" | "redis";

const DEPENDENCIES = Symbol("HEALTH_DEPENDENCIES");

@Controller("health")
class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Inject(DEPENDENCIES) private readonly deps: Dependency[],
    // Optional: a service that doesn't use Redis simply hasn't registered it.
    @Optional() @Inject(DATABASE) private readonly database?: Database,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  ready() {
    return { status: "ok" };
  }

  @Get("dependencies")
  @HealthCheck()
  dependencies() {
    return this.health.check(this.deps.map((dep) => () => this.check(dep)));
  }

  private async check(dep: Dependency) {
    const status = this.indicator.check(dep);
    try {
      if (dep === "db") {
        if (!this.database) {
          throw new Error("DatabaseModule is not registered");
        }
        await this.database.write.$queryRaw`SELECT 1`;
      }
      if (dep === "redis") {
        if (!this.redis) {
          throw new Error("RedisModule is not registered");
        }
        await this.redis.ping();
      }
      return status.up();
    } catch (error) {
      // Prisma, ioredis and the checks above all throw Errors.
      return status.down({ message: asError(error).message });
    }
  }
}

@Module({})
export class HealthModule {
  static forRoot(dependencies: Dependency[]): DynamicModule {
    return {
      module: HealthModule,
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController],
      providers: [{ provide: DEPENDENCIES, useValue: dependencies }],
    };
  }
}
