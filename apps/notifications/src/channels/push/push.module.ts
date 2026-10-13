import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { required } from "@repo/contracts/objects";
import { env, pushPlatforms } from "../../env";
import { ApnsTransport } from "./apns";
import { FcmTransport } from "./fcm";
import { PushChannel } from "./push.channel";
import { PUSH_TRANSPORTS, type PushTransports } from "./push-transport";
import { WebPushTransport } from "./web-push";

// A platform is on only when all of its variables are set (checked at boot in env.ts).
function createTransports(): PushTransports {
  const transports: PushTransports = {};
  if (pushPlatforms.android) {
    transports.android = new FcmTransport({
      projectId: required(env.FCM_PROJECT_ID, "FCM_PROJECT_ID"),
      clientEmail: required(env.FCM_CLIENT_EMAIL, "FCM_CLIENT_EMAIL"),
      // Keys pasted into env files carry literal "\\n"s.
      privateKey: required(env.FCM_PRIVATE_KEY, "FCM_PRIVATE_KEY").replaceAll("\\n", "\n"),
      ...(env.FCM_TOKEN_URL && { tokenUrl: env.FCM_TOKEN_URL }),
      ...(env.FCM_API_URL && { apiUrl: env.FCM_API_URL }),
    });
  }
  if (pushPlatforms.ios) {
    transports.ios = new ApnsTransport({
      keyId: required(env.APNS_KEY_ID, "APNS_KEY_ID"),
      teamId: required(env.APNS_TEAM_ID, "APNS_TEAM_ID"),
      privateKey: required(env.APNS_PRIVATE_KEY, "APNS_PRIVATE_KEY").replaceAll("\\n", "\n"),
      bundleId: required(env.APNS_BUNDLE_ID, "APNS_BUNDLE_ID"),
      url: env.APNS_URL,
    });
  }
  if (pushPlatforms.web) {
    transports.web = new WebPushTransport({
      publicKey: required(env.VAPID_PUBLIC_KEY, "VAPID_PUBLIC_KEY"),
      privateKey: required(env.VAPID_PRIVATE_KEY, "VAPID_PRIVATE_KEY"),
      subject: required(env.VAPID_SUBJECT, "VAPID_SUBJECT"),
      testOrigin: env.WEB_PUSH_TEST_ORIGIN,
    });
  }
  return transports;
}

export class TransportsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PUSH_TRANSPORTS) private readonly transports: PushTransports) {}
  async onApplicationShutdown() {
    await Promise.all(Object.values(this.transports).map((transport) => transport?.close?.()));
  }
}

@Module({
  providers: [
    { provide: PUSH_TRANSPORTS, useFactory: createTransports },
    TransportsLifecycle,
    PushChannel,
  ],
  exports: [PushChannel],
})
export class PushModule {}
