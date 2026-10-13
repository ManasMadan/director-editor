"use client";

import type { WebhookEndpoint } from "@repo/contracts/api";
import { Badge } from "@repo/ui/components/badge";
import { useTranslations } from "next-intl";

export function EndpointStatus({ endpoint }: { endpoint: WebhookEndpoint }) {
  const t = useTranslations("workspace.webhooks.status");
  if (!endpoint.disabledAt) {
    return <Badge variant="secondary">{t("enabled")}</Badge>;
  }
  return (
    <Badge variant="destructive">
      {t(endpoint.disabledReason === "failing" ? "failing" : "manual")}
    </Badge>
  );
}
