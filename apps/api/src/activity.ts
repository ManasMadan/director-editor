/**
 * The API's activity log (logActivity in @repo/nest-common, docs/observability.md): one
 * line per sign-in, procedure call, live call and publish, named from
 * @repo/contracts/activity. Injected as a plain function, so the code outside Nest's
 * container (the auth configuration, the live call, the procedure pipeline) writes lines
 * the same way:
 *
 *   constructor(@InjectActivity() private readonly activity: RecordActivity) {}
 *   this.activity({ activity: "director.publish_started", target: { cutId } });
 */
import { Global, Inject, Module } from "@nestjs/common";
import type { ActivityName } from "@repo/contracts/activity";
import { type Activity, logActivity, PinoLogger } from "@repo/nest-common";

/** Writes one of this API's activity lines. */
export type RecordActivity = (activity: Activity<ActivityName>) => void;

export const ACTIVITY = Symbol("ACTIVITY");
export const InjectActivity = () => Inject(ACTIVITY);

@Global()
@Module({
  providers: [
    {
      provide: ACTIVITY,
      inject: [PinoLogger],
      useFactory: (log: PinoLogger): RecordActivity => {
        log.setContext("activity");
        return (activity) => logActivity(log, activity);
      },
    },
  ],
  exports: [ACTIVITY],
})
export class ActivityModule {}
