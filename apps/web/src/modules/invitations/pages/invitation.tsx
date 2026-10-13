"use client";

import { useInvitationQuery } from "@repo/client/auth/invitation";
import { Button } from "@repo/ui/components/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@repo/ui/components/card";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { useAuthErrorMessage } from "@/modules/auth";

/** An organization invitation, opened from the email link (signed-in users only). */
export function InvitationPage({ id }: { id: string }) {
  const t = useTranslations("invitations");
  const router = useRouter();
  const queryClient = useQueryClient();
  const errorMessage = useAuthErrorMessage();
  const invitation = useInvitationQuery(authClient, id);

  const data = invitation.data;

  async function accept(organizationName: string) {
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (error) {
      toast.error(errorMessage(error));
      return;
    }
    // Work in the organization just joined; everything cached belonged to the previous one.
    await authClient.organization.setActive({ organizationId: data.invitation.organizationId });
    queryClient.clear();
    toast.success(t("accepted", { organizationName }));
    router.replace("/dashboard");
  }

  async function decline() {
    const { error } = await authClient.organization.rejectInvitation({ invitationId: id });
    if (error) {
      toast.error(errorMessage(error));
    } else {
      router.replace("/dashboard");
    }
  }

  return (
    <div className="mx-auto mt-8 w-full max-w-sm">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            {invitation.isPending ? <Skeleton className="h-4 w-48" /> : null}
            {data ? t("description", { organizationName: data.organizationName }) : null}
            {!invitation.isPending && !data ? t("invalid") : null}
          </CardDescription>
        </CardHeader>
        {data ? (
          <CardFooter className="gap-2">
            <Button onClick={() => accept(data.organizationName)}>{t("accept")}</Button>
            <Button variant="ghost" onClick={decline}>
              {t("decline")}
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}
