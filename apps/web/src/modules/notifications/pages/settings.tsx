"use client";

import { useApiErrorMessage } from "@repo/client";
import { useNotificationPreferencesQuery } from "@repo/client/api/notifications/preferences";
import { useUpdateNotificationPreferencesMutation } from "@repo/client/api/notifications/update-preferences";
import type { NotificationPreferences } from "@repo/contracts/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Field, FieldLabel } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { BrowserPushCard } from "../components/browser-push-card";

const toTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const toMinutes = (time: string) => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

export function NotificationSettingsPage() {
  const t = useTranslations("notificationSettings");
  const errorMessage = useApiErrorMessage();
  const preferences = useNotificationPreferencesQuery();
  const update = useUpdateNotificationPreferencesMutation();
  const save = (changes: Parameters<typeof update.mutate>[0]) =>
    update.mutate(changes, {
      onSuccess: () => toast.success(t("saved")),
      onError: (error) => toast.error(errorMessage(error)),
    });

  if (!preferences.data) {
    return <Skeleton className="h-64" />;
  }
  const data: NotificationPreferences = preferences.data;
  const quiet = data.quietHours;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {data.categories.map((category) => (
            <fieldset key={category.name} className="flex flex-col gap-2">
              <legend className="text-sm font-medium">
                {t(`categories.${category.name}.title`)}
              </legend>
              <p className="text-xs text-muted-foreground">
                {t(`categories.${category.name}.description`)}
              </p>
              <div className="flex flex-wrap gap-4">
                {category.channels.map(({ channel, enabled }) => {
                  const id = `pref-${category.name}-${channel}`;
                  return (
                    <Field key={channel} orientation="horizontal" className="w-auto">
                      <Checkbox
                        id={id}
                        checked={enabled}
                        onCheckedChange={(checked) =>
                          save({
                            channels: [
                              { category: category.name, channel, enabled: checked === true },
                            ],
                          })
                        }
                      />
                      <FieldLabel htmlFor={id} className="font-normal">
                        {t(`channels.${channel}`)}
                      </FieldLabel>
                    </Field>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </CardContent>
      </Card>
      <BrowserPushCard />
      <Card>
        <CardHeader>
          <CardTitle>{t("digest.title")}</CardTitle>
          <CardDescription>{t("digest.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Field orientation="horizontal">
            <Checkbox
              id="daily-digest"
              checked={data.dailyDigest}
              onCheckedChange={(checked) => save({ dailyDigest: checked === true })}
            />
            <FieldLabel htmlFor="daily-digest" className="font-normal">
              {t("digest.title")}
            </FieldLabel>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("quietHours.title")}</CardTitle>
          <CardDescription>{t("quietHours.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field orientation="horizontal">
            <Checkbox
              id="quiet-hours"
              checked={data.quietHours !== null}
              onCheckedChange={(checked) =>
                save({ quietHours: checked === true ? { start: 22 * 60, end: 7 * 60 } : null })
              }
            />
            <FieldLabel htmlFor="quiet-hours" className="font-normal">
              {t("quietHours.enable")}
            </FieldLabel>
          </Field>
          {quiet ? (
            <div className="flex gap-4">
              {(["start", "end"] as const).map((edge) => (
                <Field key={edge} className="w-36">
                  <FieldLabel htmlFor={`quiet-${edge}`}>{t(`quietHours.${edge}`)}</FieldLabel>
                  <Input
                    id={`quiet-${edge}`}
                    type="time"
                    defaultValue={toTime(quiet[edge])}
                    onBlur={(event) => {
                      if (!event.target.value) {
                        return;
                      }
                      const minutes = toMinutes(event.target.value);
                      if (minutes !== quiet[edge]) {
                        save({ quietHours: { ...quiet, [edge]: minutes } });
                      }
                    }}
                  />
                </Field>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
