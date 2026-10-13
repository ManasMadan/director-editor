"use client";

import { useApiErrorMessage } from "@repo/client";
import { useDeleteWebhookEndpointMutation } from "@repo/client/api/webhooks/delete-endpoint";
import { useWebhookDeliveriesInfiniteQuery } from "@repo/client/api/webhooks/list-deliveries";
import { useWebhookEndpointsQuery } from "@repo/client/api/webhooks/list-endpoints";
import { useRedeliverWebhookMutation } from "@repo/client/api/webhooks/redeliver";
import { useRotateWebhookSecretMutation } from "@repo/client/api/webhooks/rotate-secret";
import { useSendWebhookTestMutation } from "@repo/client/api/webhooks/send-test";
import { useUpdateWebhookEndpointMutation } from "@repo/client/api/webhooks/update-endpoint";
import { WEBHOOK_SECRET_OVERLAP_HOURS, type WebhookDelivery } from "@repo/contracts/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
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
import { Skeleton } from "@repo/ui/components/skeleton";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { EndpointStatus } from "../components/endpoint-status";
import { SecretDialog } from "../components/secret-dialog";

export function WebhookEndpointPage({ id }: { id: string }) {
  const t = useTranslations("workspace.webhooks");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const errorMessage = useApiErrorMessage();
  const endpoints = useWebhookEndpointsQuery();
  const update = useUpdateWebhookEndpointMutation();
  const remove = useDeleteWebhookEndpointMutation();
  const rotate = useRotateWebhookSecretMutation();
  const sendTest = useSendWebhookTestMutation();
  const [secret, setSecret] = useState<string | null>(null);
  const endpoint = endpoints.data?.find((candidate) => candidate.id === id);
  const onError = (error: unknown) => toast.error(errorMessage(error));

  if (endpoints.isPending) {
    return <Skeleton className="h-40" />;
  }
  if (!endpoint) {
    return (
      <p className="text-sm text-muted-foreground">
        {errorMessage({ code: "WEBHOOK_ENDPOINT_NOT_FOUND" })}
      </p>
    );
  }

  return (
    <>
      <Link href="/settings/webhooks" className="text-sm underline-offset-4 hover:underline">
        ← {t("back")}
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 break-all">
            {endpoint.url}
            <EndpointStatus endpoint={endpoint} />
          </CardTitle>
          {endpoint.description ? <CardDescription>{endpoint.description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              update.mutate({ id, enabled: Boolean(endpoint.disabledAt) }, { onError })
            }
            disabled={update.isPending}
          >
            {endpoint.disabledAt ? t("enable") : t("disable")}
          </Button>
          <Button
            variant="outline"
            disabled={Boolean(endpoint.disabledAt) || sendTest.isPending}
            onClick={() =>
              sendTest.mutate({ id }, { onError, onSuccess: () => toast.success(t("testSent")) })
            }
          >
            {t("test")}
          </Button>
          <Button
            variant="outline"
            disabled={rotate.isPending}
            onClick={() =>
              rotate.mutate(
                { id },
                {
                  onError,
                  onSuccess: (result) => {
                    toast.success(t("secret.rotated", { hours: WEBHOOK_SECRET_OVERLAP_HOURS }));
                    setSecret(result.secret);
                  },
                },
              )
            }
          >
            {t("secret.rotate")}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive" />}>
              {t("delete")}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("delete")}</AlertDialogTitle>
              </AlertDialogHeader>
              <p className="text-sm break-all">{endpoint.url}</p>
              <AlertDialogFooter>
                <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    remove.mutate(
                      { id },
                      {
                        onError,
                        onSuccess: () => {
                          toast.success(t("deleted"));
                          router.replace("/settings/webhooks");
                        },
                      },
                    )
                  }
                >
                  {t("delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
      <DeliveriesCard endpointId={id} />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}

function DeliveriesCard({ endpointId }: { endpointId: string }) {
  const t = useTranslations("workspace.webhooks.deliveries");
  const deliveries = useWebhookDeliveriesInfiniteQuery(endpointId);
  const redeliver = useRedeliverWebhookMutation();
  const items = deliveries.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {deliveries.isPending ? <Skeleton className="h-20" /> : null}
        {!deliveries.isPending && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}
        {items.length > 0 ? (
          <ul className="flex flex-col divide-y" aria-label={t("title")}>
            {items.map((delivery) => (
              <DeliveryRow key={delivery.id} delivery={delivery} redeliver={redeliver} />
            ))}
          </ul>
        ) : null}
        {deliveries.hasNextPage ? (
          <Button
            variant="outline"
            className="self-start"
            onClick={() => deliveries.fetchNextPage()}
          >
            {t("loadMore")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

const STATUS_BADGE = {
  failed: "destructive",
  succeeded: "secondary",
  pending: "outline",
} as const satisfies Record<WebhookDelivery["status"], string>;

function DeliveryRow({
  delivery,
  redeliver,
}: {
  delivery: WebhookDelivery;
  redeliver: ReturnType<typeof useRedeliverWebhookMutation>;
}) {
  const t = useTranslations("workspace.webhooks.deliveries");
  const format = useFormatter();
  const errorMessage = useApiErrorMessage();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
      <div className="flex flex-col">
        <code className="text-xs">{delivery.eventName}</code>
        <span className="text-xs text-muted-foreground">
          {format.dateTime(delivery.createdAt, { dateStyle: "medium", timeStyle: "short" })} ·{" "}
          {t("attempts", { count: delivery.attempts })}
          {delivery.lastStatus ? ` · HTTP ${delivery.lastStatus}` : ""}
          {delivery.lastError && !delivery.lastStatus
            ? ` · ${t(`error.${delivery.lastError}`)}`
            : ""}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={STATUS_BADGE[delivery.status]}>{t(delivery.status)}</Badge>
        {delivery.status === "pending" ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              redeliver.mutate(
                { id: delivery.id },
                {
                  onError: (error) => toast.error(errorMessage(error)),
                  onSuccess: () => toast.success(t("redelivered")),
                },
              )
            }
          >
            {t("redeliver")}
          </Button>
        )}
      </div>
    </li>
  );
}
