/**
 * Data access for the account fields this module reads (the profile picture). The user
 * table has no row-level security; each query names its user.
 */
import { Injectable } from "@nestjs/common";
import type { UserId } from "@repo/contracts/ids";
import { type Database, InjectDatabase } from "@repo/nest-common";

@Injectable()
export class UserRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  image(userId: UserId) {
    return this.database.read.user.findUniqueOrThrow({
      where: { id: userId },
      select: { image: true },
    });
  }
}
