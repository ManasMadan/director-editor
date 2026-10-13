"use client";

import { useBillingOverviewQuery } from "@repo/client/api/billing/overview";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * Says what the plan doesn't allow, with a way to upgrade. Renders nothing when billing
 * is off or the plan allows it. For owners and admins (who can see billing).
 */
export function UpgradeHint({ entitlement }: { entitlement: "webhooks" | "members" }) {
  const t = useTranslations("billing");
  const { data } = useBillingOverviewQuery();
  if (!data?.enabled) {
    return null;
  }
  const limit = data.entitlements.members;
  const blocked =
    entitlement === "webhooks"
      ? !data.entitlements.webhooks
      : limit !== null && data.members >= limit;
  if (!blocked) {
    return null;
  }
  return (
    <Alert>
      <AlertDescription className="flex flex-col items-start gap-2">
        {entitlement === "webhooks"
          ? t("upgradeForWebhooks")
          : t("limitReached", { limit: Number(limit) })}
        <Link href="/settings/billing" className="font-medium underline underline-offset-4">
          {t("upgrade.title")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}

/** Whether the plan includes webhooks (true while loading, and when billing is off). */
export function useHasWebhooks() {
  const { data } = useBillingOverviewQuery();
  return !data?.enabled || data.entitlements.webhooks;
}
