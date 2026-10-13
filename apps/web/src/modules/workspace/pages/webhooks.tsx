"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useApiErrorMessage } from "@repo/client";
import { useCreateWebhookEndpointMutation } from "@repo/client/api/webhooks/create-endpoint";
import { useWebhookEndpointsQuery } from "@repo/client/api/webhooks/list-endpoints";
import { webhookEvents } from "@repo/contracts/events";
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
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@repo/ui/components/field";
import { Skeleton } from "@repo/ui/components/skeleton";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { TextField } from "@/components/form-fields";
import { UpgradeHint, useHasWebhooks } from "@/modules/billing";
import { EndpointStatus } from "../components/endpoint-status";
import { SecretDialog } from "../components/secret-dialog";

export function WorkspaceWebhooksPage() {
  const t = useTranslations("workspace.webhooks");
  const endpoints = useWebhookEndpointsQuery();
  const errorMessage = useApiErrorMessage();
  const [secret, setSecret] = useState<string | null>(null);
  const hasWebhooks = useHasWebhooks();

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {endpoints.isPending ? <Skeleton className="h-16" /> : null}
          {endpoints.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(endpoints.error)}
            </p>
          ) : null}
          {endpoints.isSuccess && endpoints.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : null}
          {endpoints.isSuccess && endpoints.data.length > 0 ? (
            <ul className="flex flex-col divide-y">
              {endpoints.data.map((endpoint) => (
                <li key={endpoint.id} className="flex items-center justify-between gap-3 py-2">
                  <Link
                    href={`/settings/webhooks/${endpoint.id}` as Route}
                    className="truncate text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {endpoint.url}
                  </Link>
                  <EndpointStatus endpoint={endpoint} />
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
      {hasWebhooks ? (
        <AddEndpointCard onCreated={setSecret} />
      ) : (
        <UpgradeHint entitlement="webhooks" />
      )}
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}

function AddEndpointCard({ onCreated }: { onCreated: (secret: string) => void }) {
  const t = useTranslations("workspace.webhooks");
  const tEvents = useTranslations("workspace.webhooks.eventLabels");
  const errorMessage = useApiErrorMessage();
  const create = useCreateWebhookEndpointMutation();
  const schema = z.object({
    url: z.url({ protocol: /^https?$/ }),
    description: z.string().max(200),
    events: z.array(z.enum(webhookEvents)),
  });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { url: "", description: "", events: [] },
  });

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
              onCreated(created.secret);
            } catch (error) {
              toast.error(errorMessage(error));
            }
          })}
        >
          <FieldGroup>
            <TextField
              control={form.control}
              name="url"
              label={t("url")}
              type="url"
              placeholder="https://example.com/webhooks"
            />
            <FieldDescription className="-mt-4">{t("urlHint")}</FieldDescription>
            <TextField control={form.control} name="description" label={t("descriptionLabel")} />
            <Controller
              control={form.control}
              name="events"
              render={({ field }) => (
                <FieldSet>
                  <FieldLegend variant="label">{t("events")}</FieldLegend>
                  <FieldDescription>{t("allEvents")}</FieldDescription>
                  {webhookEvents.map((name) => (
                    <Field key={name} orientation="horizontal">
                      <Checkbox
                        id={`event-${name}`}
                        checked={field.value.includes(name)}
                        onCheckedChange={(checked) =>
                          field.onChange(
                            checked
                              ? [...field.value, name]
                              : field.value.filter((value) => value !== name),
                          )
                        }
                      />
                      <FieldLabel htmlFor={`event-${name}`} className="font-normal">
                        <code className="text-xs">{name}</code>
                        <span className="text-muted-foreground">{tEvents(name)}</span>
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldSet>
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
