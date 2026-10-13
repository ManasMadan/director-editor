/**
 * Push to every device a user registered, on each device's platform. Dead tokens
 * (uninstalled apps, expired browser subscriptions) are deleted when a provider says so.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { UserId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { withUser } from "@repo/db";
import { type Database, InjectDatabase, InjectPinoLogger, PinoLogger } from "@repo/nest-common";
import {
  PUSH_TRANSPORTS,
  type PushMessage,
  type PushPlatform,
  type PushResult,
  type PushTransports,
} from "./push-transport";

export interface PushDevice {
  id: string;
  platform: PushPlatform;
  token: string;
}

@Injectable()
export class PushChannel {
  constructor(
    @Inject(PUSH_TRANSPORTS) private readonly transports: PushTransports,
    @InjectDatabase() private readonly database: Database,
    @InjectPinoLogger(PushChannel.name) private readonly log: PinoLogger,
  ) {}

  /** The user's devices this service can reach (platforms that are configured). */
  async devices(userId: UserId): Promise<PushDevice[]> {
    const rows = await withUser(this.database.read, userId).notificationDevice.findMany({
      where: { userId },
      select: { id: true, platform: true, token: true },
    });
    return rows.filter((row): row is PushDevice => row.platform in this.transports);
  }

  async send(userId: UserId, device: PushDevice, message: PushMessage): Promise<PushResult> {
    // devices() only returns devices on platforms that have a transport.
    const transport = required(this.transports[device.platform], `a ${device.platform} transport`);
    const result = await transport.send(device.token, message);
    if (!result.ok && result.gone) {
      await withUser(this.database.write, userId).notificationDevice.deleteMany({
        where: { id: device.id },
      });
      this.log.info(
        { deviceId: device.id, platform: device.platform },
        "removed a dead push token",
      );
    }
    return result;
  }
}
