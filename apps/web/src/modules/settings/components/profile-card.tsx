"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMeQuery } from "@repo/client/api/user/me";
import { nameSchema } from "@repo/contracts/auth";
import { isLocale, type Locale, locales } from "@repo/i18n/locales";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { setPreferenceCookie } from "@/lib/cookies";
import { useAuthErrorMessage } from "@/modules/auth";

// Browsers list canonical zones only, without "UTC", which is our default for new users.
const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
// A language code the browser doesn't know comes back as the code itself.
const nativeName = (locale: string) =>
  String(new Intl.DisplayNames([locale], { type: "language" }).of(locale));

export function ProfileCard() {
  const t = useTranslations("settings.profile");
  const { data: me } = useMeQuery();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {me ? (
          <ProfileForm
            initial={{
              name: me.name,
              locale: isLocale(me.locale) ? me.locale : "en",
              timezone: me.timezone,
            }}
          />
        ) : (
          <Skeleton className="h-48" />
        )}
      </CardContent>
    </Card>
  );
}

/** The languages, each named in itself. */
function LanguageSelect({
  value,
  onChange,
}: {
  value: Locale;
  onChange: (locale: Locale) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(chosen) => chosen && onChange(chosen)}
      items={locales.map((locale) => ({ value: locale, label: nativeName(locale) }))}
    >
      <SelectTrigger id="locale" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {locales.map((locale) => (
          <SelectItem key={locale} value={locale}>
            {nativeName(locale)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ProfileForm({ initial }: { initial: { name: string; locale: Locale; timezone: string } }) {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const errorMessage = useAuthErrorMessage();
  const { refetch: refetchSession } = authClient.useSession();
  const schema = z.object({
    name: z
      .string()
      .refine((value) => nameSchema.safeParse(value).success, t("validation.nameMin")),
    locale: z.enum(locales),
    timezone: z.string().refine((value) => TIME_ZONES.includes(value)),
  });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: initial });

  async function onSubmit(values: z.infer<typeof schema>) {
    const { error } = await authClient.updateUser(values);
    if (error) {
      toast.error(errorMessage(error));
      return;
    }
    // Session first: PreferenceSync treats the saved language as the truth.
    await refetchSession();
    setPreferenceCookie("locale", values.locale);
    setPreferenceCookie("tz", values.timezone);
    await queryClient.invalidateQueries();
    form.reset(values);
    toast.success(t("settings.profile.saved"));
    // Re-render server components in the new language and zone.
    router.refresh();
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <TextField
          control={form.control}
          name="name"
          label={t("settings.profile.name")}
          autoComplete="name"
        />
        <Controller
          control={form.control}
          name="locale"
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor="locale">{t("settings.profile.language")}</FieldLabel>
              <LanguageSelect value={field.value} onChange={field.onChange} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="timezone"
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor="timezone">{t("settings.profile.timeZone")}</FieldLabel>
              {/* ~400 zones: the native select is searchable by typing and accessible everywhere. */}
              <select
                id="timezone"
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
                {...field}
              >
                {TIME_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </Field>
          )}
        />
        <Button
          type="submit"
          disabled={form.formState.isSubmitting || !form.formState.isDirty}
          className="self-start"
        >
          {t("common.save")}
        </Button>
      </FieldGroup>
    </form>
  );
}
