"use client";

import type { Workspace } from "@repo/client/auth";
import { useOAuthClientQuery } from "@repo/client/auth/oauth-client";
import { loosely } from "@repo/i18n";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { isOAuthRequest } from "@/lib/routes";
import { useAuthErrorMessage } from "@/modules/auth";
import { isPersonal, useWorkspaces } from "@/modules/workspace";

/**
 * Approving an app (an MCP client) that asked, over OAuth, to act for the user in one
 * workspace. The authorization server sends the user here with its signed request in
 * the query; every call from this page carries it (packages/client auth), and the
 * answer is where to go next, which the auth client navigates to.
 *
 * Picking another workspace makes it the active one, which re-runs the request for that
 * workspace: this page again, or straight back to the app if it was approved there.
 */
export function OAuthConsentPage() {
  const t = useTranslations("oauth");
  const errorMessage = useAuthErrorMessage();
  const params = useSearchParams();
  const workspaceLabelId = useId();
  const [busy, setBusy] = useState(false);
  const clientId = params.get("client_id");
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const returnTo = hostOf(params.get("redirect_uri"));
  const { data: session } = authClient.useSession();
  const workspaces = useWorkspaces();
  const client = useOAuthClientQuery(authClient, clientId);

  if (!isOAuthRequest(params) || !clientId) {
    return <Shell title={t("title")} description={t("missing")} />;
  }

  const appName = client.data?.client_name ?? t("unnamed");
  const activeId = session?.session.activeOrganizationId ?? "";
  const workspaceName = (workspace: { name: string; metadata?: unknown }) =>
    isPersonal(workspace) ? t("personal") : workspace.name;

  async function answer(accept: boolean) {
    setBusy(true);
    const { error } = await authClient.oauth2.consent({ accept });
    // On success the auth client is already taking the user back to the app.
    if (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }

  async function switchWorkspace(organizationId: string) {
    setBusy(true);
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <Shell
      title={client.isPending ? <Skeleton className="h-5 w-48" /> : t("heading", { appName })}
      description={t("description", { appName })}
    >
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span id={workspaceLabelId} className="text-sm font-medium">
            {t("workspace")}
          </span>
          {workspaces.data ? (
            <Select
              value={activeId}
              disabled={busy}
              onValueChange={(id) => {
                if (id && id !== activeId) {
                  void switchWorkspace(id);
                }
              }}
              items={workspaces.data.map((workspace: Workspace) => ({
                value: workspace.id,
                label: workspaceName(workspace),
              }))}
            >
              <SelectTrigger aria-labelledby={workspaceLabelId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workspaces.data.map((workspace: Workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspaceName(workspace)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Skeleton className="h-9 w-full" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("canDo", { appName })}</span>
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {scopes.map((scope) => (
              <li key={scope}>
                {loosely(t).has(`scopes.${scope}`) ? loosely(t)(`scopes.${scope}`) : scope}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-muted-foreground">
          {returnTo ? t("returnTo", { host: returnTo }) : null} {t("trust")}
        </p>
      </CardContent>
      {/* Both wait for the app's details: the server renders this page before the
          browser can act on a click, and a click on an enabled button then is lost. */}
      <CardFooter className="gap-2">
        <Button onClick={() => answer(true)} disabled={busy || client.isPending}>
          {t("allow")}
        </Button>
        <Button variant="ghost" onClick={() => answer(false)} disabled={busy || client.isPending}>
          {t("deny")}
        </Button>
      </CardFooter>
    </Shell>
  );
}

function Shell({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto mt-8 w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children}
      </Card>
    </div>
  );
}

/** Where the app will receive the answer, shown so a look-alike app stands out. */
function hostOf(uri: string | null) {
  if (!uri) {
    return null;
  }
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}
