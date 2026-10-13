"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useApiErrorMessage } from "@repo/client";
import { useCreateApiKeyMutation } from "@repo/client/api/api-keys/create";
import { useApiKeysQuery } from "@repo/client/api/api-keys/list";
import { useRevokeApiKeyMutation } from "@repo/client/api/api-keys/revoke";
import {
  API_KEY_EXPIRY_DAYS,
  API_KEY_SCOPES,
  type ApiKey,
  createApiKeyInput,
} from "@repo/contracts/api";
import { MINUTE_MS } from "@repo/contracts/time";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@repo/ui/components/alert-dialog";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Checkbox } from "@repo/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@repo/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { TextField } from "@/components/form-fields";
import { SecretDialog } from "../components/secret-dialog";

export function WorkspaceApiKeysPage() {
  const t = useTranslations("workspace.apiKeys");
  const keys = useApiKeysQuery();
  const errorMessage = useApiErrorMessage();
  const [secret, setSecret] = useState<string | null>(null);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            {t("description")}{" "}
            <a
              href="/api/v1/openapi.json"
              className="underline underline-offset-4"
              target="_blank"
              rel="noreferrer"
            >
              {t("reference")}
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keys.isPending ? <Skeleton className="h-16" /> : null}
          {keys.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(keys.error)}
            </p>
          ) : null}
          {keys.isSuccess && keys.data.length > 0 ? (
            <ul className="flex flex-col divide-y" aria-label={t("title")}>
              {keys.data.map((key) => (
                <KeyRow key={key.id} apiKey={key} />
              ))}
            </ul>
          ) : null}
          {keys.isSuccess && keys.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : null}
        </CardContent>
      </Card>
      <CreateKeyCard onCreated={setSecret} />
      <SecretDialog
        secret={secret}
        onClose={() => setSecret(null)}
        labels="workspace.apiKeys.key"
        testId="api-key"
      />
    </>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKey }) {
  const t = useTranslations("workspace.apiKeys");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  // An explicit, ticking "now" keeps server and client renders in agreement.
  const now = useNow({ updateInterval: MINUTE_MS });
  const errorMessage = useApiErrorMessage();
  const revoke = useRevokeApiKeyMutation();
  const date = (value: Date) => format.dateTime(value, { dateStyle: "medium" });

  return (
    <li className="flex items-center justify-between gap-3 py-3 text-sm">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{apiKey.name}</span>
          <code className="text-xs text-muted-foreground">{apiKey.start}…</code>
        </span>
        <span className="flex flex-wrap gap-1">
          {apiKey.scopes.map((scope) => (
            <Badge key={scope} variant="secondary">
              <code className="text-xs">{scope}</code>
            </Badge>
          ))}
        </span>
        <span className="text-xs text-muted-foreground">
          {apiKey.createdBy
            ? t("createdBy", { name: apiKey.createdBy.name, date: date(apiKey.createdAt) })
            : t("createdByGone", { date: date(apiKey.createdAt) })}
          {" · "}
          {apiKey.lastUsedAt
            ? t("lastUsed", { when: format.relativeTime(apiKey.lastUsedAt, now) })
            : t("neverUsed")}
          {" · "}
          {apiKey.expiresAt ? t("expires", { date: date(apiKey.expiresAt) }) : t("noExpiry")}
        </span>
      </div>
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button variant="outline" size="sm" aria-label={`${t("revoke")}: ${apiKey.name}`} />
          }
        >
          {t("revoke")}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revokeTitle", { name: apiKey.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("revokeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                revoke.mutate(
                  { id: apiKey.id },
                  {
                    onSuccess: () => toast.success(t("revoked", { name: apiKey.name })),
                    onError: (error) => toast.error(errorMessage(error)),
                  },
                )
              }
            >
              {t("revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function CreateKeyCard({ onCreated }: { onCreated: (key: string) => void }) {
  const t = useTranslations("workspace.apiKeys");
  const errorMessage = useApiErrorMessage();
  const create = useCreateApiKeyMutation();
  const form = useForm({
    resolver: zodResolver(createApiKeyInput),
    defaultValues: { name: "", scopes: [], expiresInDays: 90 },
  });
  // Every key expires (a stolen session can't leave one behind for good).
  const expiryItems = API_KEY_EXPIRY_DAYS.map((days) => ({
    value: String(days),
    label: t("expiryDays", { days }),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("add")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={form.handleSubmit(async (values) => {
            try {
              const created = await create.mutateAsync(values);
              form.reset();
              toast.success(t("created"));
              onCreated(created.key);
            } catch (error) {
              toast.error(errorMessage(error));
            }
          })}
        >
          <FieldGroup>
            <TextField control={form.control} name="name" label={t("name")} />
            <FieldDescription className="-mt-4">{t("nameHint")}</FieldDescription>
            <Controller
              control={form.control}
              name="scopes"
              render={({ field, fieldState }) => (
                <FieldSet data-invalid={fieldState.invalid || undefined}>
                  <FieldLegend variant="label">{t("scopesLabel")}</FieldLegend>
                  <FieldDescription>{t("scopesHint")}</FieldDescription>
                  {API_KEY_SCOPES.map((scope) => (
                    <Field key={scope} orientation="horizontal">
                      <Checkbox
                        id={`scope-${scope}`}
                        checked={field.value.includes(scope)}
                        aria-invalid={fieldState.invalid || undefined}
                        onCheckedChange={(checked) =>
                          field.onChange(
                            checked
                              ? [...field.value, scope]
                              : field.value.filter((value) => value !== scope),
                          )
                        }
                      />
                      <FieldLabel htmlFor={`scope-${scope}`} className="font-normal">
                        <code className="text-xs">{scope}</code>
                        <span className="text-muted-foreground">{t(`scopes.${scope}`)}</span>
                      </FieldLabel>
                    </Field>
                  ))}
                  {fieldState.invalid ? <FieldError>{t("scopesRequired")}</FieldError> : null}
                </FieldSet>
              )}
            />
            <Controller
              control={form.control}
              name="expiresInDays"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="api-key-expiry">{t("expiry")}</FieldLabel>
                  <Select
                    value={String(field.value)}
                    onValueChange={(value) => value && field.onChange(Number(value))}
                    items={expiryItems}
                  >
                    <SelectTrigger id="api-key-expiry" className="w-full sm:w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {expiryItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <Button type="submit" className="self-start" disabled={create.isPending}>
              {t("create")}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
