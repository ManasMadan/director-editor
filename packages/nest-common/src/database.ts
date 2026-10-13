/**
 * The service's database connections as an injectable, lifecycle-managed provider.
 *
 *   @Injectable()
 *   class TodoRepository {
 *     constructor(@InjectDatabase() private readonly database: Database) {}
 *     list(orgId: OrgId) { return withTenant(this.database.read, orgId).todo.findMany(); }
 *   }
 *
 * One pool per process, created at boot from the service's validated env and closed on
 * shutdown so deploys never leak connections. Queries pick `read` or `write`
 * explicitly, which is what makes adding read replicas a one-file change later
 * (see packages/db/src/client.ts).
 */
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { createDatabase, type Database, type DatabaseOptions } from "@repo/db";

export const DATABASE = Symbol("DATABASE");
export const InjectDatabase = () => Inject(DATABASE);
export type { Database };

class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@InjectDatabase() private readonly database: Database) {}
  async onApplicationShutdown() {
    await this.database.disconnect();
  }
}

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE, useFactory: () => createDatabase(options) },
        DatabaseLifecycle,
      ],
      exports: [DATABASE],
    };
  }
}
