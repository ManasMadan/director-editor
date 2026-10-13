"use client";

import { useApiErrorMessage } from "@repo/client";
import { useCheckoutMutation } from "@repo/client/api/billing/checkout";
import { useInvoicesQuery } from "@repo/client/api/billing/invoices";
import { useBillingOverviewQuery } from "@repo/client/api/billing/overview";
import { usePortalMutation } from "@repo/client/api/billing/portal";
import type { BillingOverview } from "@repo/contracts/api";
import { formatMoney } from "@repo/contracts/money";
import { loosely } from "@repo/i18n";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
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
import { useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { useActiveWorkspace } from "@/modules/workspace";

/** The workspace's plan, subscription and invoices (owners and admins). */
export function BillingPage() {
  const t = useTranslations("billing");
  const errorMessage = useApiErrorMessage();
  const workspace = useActiveWorkspace();
  const justPaid = useSearchParams().get("checkout") === "done";
  const overview = useBillingOverviewQuery({ untilPaid: justPaid });
  const data = overview.data;

  if (!data) {
    return overview.isError ? (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(overview.error)}
      </p>
    ) : (
      <Skeleton className="h-48" />
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            {t("description", { name: workspace.data?.name ?? "" })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!data.enabled ? (
            <p className="text-sm text-muted-foreground">{t("disabled")}</p>
          ) : (
            <>
              {justPaid ? (
                <Alert>
                  <AlertDescription>{t("checkoutDone")}</AlertDescription>
                </Alert>
              ) : null}
              <PlanSummary data={data} />
            </>
          )}
        </CardContent>
      </Card>
      {data.enabled && data.plan === "free" ? <UpgradeCard /> : null}
      {data.enabled && data.subscription ? <Invoices /> : null}
    </>
  );
}

/** The subscription's state in a sentence, with the date that matters for it. */
function statusText(
  subscription: NonNullable<BillingOverview["subscription"]>,
  t: ReturnType<typeof useTranslations<"billing">>,
  date: (value: Date) => string,
) {
  if (subscription.cancelAtPeriodEnd && subscription.status !== "canceled") {
    return t("status.canceling", { date: date(subscription.currentPeriodEnd) });
  }
  if (subscription.status === "trialing" && subscription.trialEnd) {
    return t("status.trialing", { date: date(subscription.trialEnd) });
  }
  if (subscription.status === "active") {
    return t("status.active", { date: date(subscription.currentPeriodEnd) });
  }
  if (subscription.status === "past_due") {
    return t("status.past_due");
  }
  if (subscription.status === "unpaid") {
    return t("status.unpaid");
  }
  return t("status.canceled");
}

function PlanSummary({ data }: { data: BillingOverview }) {
  const t = useTranslations("billing");
  const format = useFormatter();
  const errorMessage = useApiErrorMessage();
  const portal = usePortalMutation();
  const date = (value: Date) => format.dateTime(value, { dateStyle: "long" });
  const subscription = data.subscription;
  const status = subscription ? statusText(subscription, t, date) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-lg font-semibold">{t(`plans.${data.plan}`)}</span>
        <Badge variant="secondary">{t("current")}</Badge>
      </div>
      {subscription?.status === "past_due" ? (
        <Alert variant="destructive">
          <AlertDescription>{status}</AlertDescription>
        </Alert>
      ) : null}
      {status && subscription?.status !== "past_due" ? <p className="text-sm">{status}</p> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("seats", { seats: data.members })}</dt>
        <dd>
          {data.entitlements.members === null
            ? t("membersUnlimited", { used: data.members })
            : t("membersLimit", { used: data.members, limit: data.entitlements.members })}
        </dd>
        <dt className="text-muted-foreground">{t("webhooks")}</dt>
        <dd>{data.entitlements.webhooks ? t("included") : t("notIncluded")}</dd>
      </dl>
      {subscription ? (
        <div>
          <Button
            variant="outline"
            disabled={portal.isPending}
            onClick={() =>
              portal.mutate(undefined, {
                onSuccess: ({ url }) => window.location.assign(url),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            {t("manage")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function UpgradeCard() {
  const t = useTranslations("billing.upgrade");
  const errorMessage = useApiErrorMessage();
  const checkout = useCheckoutMutation();
  const start = (interval: "month" | "year") =>
    checkout.mutate(
      { interval },
      {
        onSuccess: ({ url }) => window.location.assign(url),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button disabled={checkout.isPending} onClick={() => start("month")}>
          {t("monthly")}
        </Button>
        <Button variant="outline" disabled={checkout.isPending} onClick={() => start("year")}>
          {t("yearly")}
        </Button>
      </CardContent>
    </Card>
  );
}

function Invoices() {
  const t = useTranslations("billing.invoices");
  const locale = useLocale();
  const format = useFormatter();
  const invoices = useInvoicesQuery(true);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {!invoices.data ? <Skeleton className="h-16" /> : null}
        {invoices.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}
        {invoices.data?.length ? (
          <ul className="flex flex-col divide-y text-sm">
            {invoices.data.map((invoice) => (
              <li key={invoice.id} className="flex items-center justify-between gap-4 py-2">
                <span>{format.dateTime(invoice.createdAt, { dateStyle: "medium" })}</span>
                <span className="text-muted-foreground">{invoice.number}</span>
                <span>
                  {formatMoney(
                    { amount: invoice.amount, currency: invoice.currency.toUpperCase() },
                    locale,
                  )}
                </span>
                <span>
                  {loosely(t).has(`status.${invoice.status}`)
                    ? loosely(t)(`status.${invoice.status}`)
                    : invoice.status}
                </span>
                {invoice.url ? (
                  <a href={invoice.url} className="underline" target="_blank" rel="noreferrer">
                    {t("view")}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
