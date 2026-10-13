import { required } from "@repo/contracts/objects";
import { env } from "../../env";
import { features } from "../../features";
import type { Procedures } from "../../rpc/procedures";
import { alerting } from "./alerting";

const alertingStatus = alerting(env.ALERTMANAGER_URL);

export const systemRouter = ({ base }: Procedures) => ({
  info: base.system.info.handler(() => ({
    release: env.RELEASE,
    features,
    minimumClientVersion: env.MINIMUM_CLIENT_VERSION,
    // The captcha is on only with its site key set (src/features.ts).
    captchaSiteKey: features.captcha
      ? required(env.TURNSTILE_SITE_KEY, "TURNSTILE_SITE_KEY")
      : null,
    webPushPublicKey: env.VAPID_PUBLIC_KEY ?? null,
  })),
  alerting: base.system.alerting.handler(async () => ({ status: await alertingStatus() })),
});
