import { required } from "@repo/contracts/objects";
import { DEMO_EMAIL } from "../../auth/demo";
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
    // Shown on the sign-in page on purpose: the demo account is there for anyone to try.
    demo: env.DEMO_PASSWORD ? { email: DEMO_EMAIL, password: env.DEMO_PASSWORD } : null,
  })),
  alerting: base.system.alerting.handler(async () => ({ status: await alertingStatus() })),
});
