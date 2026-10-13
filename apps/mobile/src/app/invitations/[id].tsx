import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useTranslations } from "use-intl";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAuthErrorMessage } from "@/hooks/use-auth";
import { authClient } from "@/lib/auth-client";

/**
 * boilerplate://invitations/<id> (and the same path of the site's URL, once universal
 * links are set up): shows the invitation, and joins the workspace only when the person
 * taps Accept. Any app or page can open a link, so opening one never joins anything.
 */
export default function Invitation() {
  const t = useTranslations("invitations");
  const errorMessage = useAuthErrorMessage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [organizationName, setOrganizationName] = useState<string | null>();
  const [failure, setFailure] = useState<string>();

  // Only signed-in users reach this screen (the root layout's protected routes).
  useEffect(() => {
    void (async () => {
      const { data } = await authClient.organization.getInvitation({ query: { id } });
      setOrganizationName(data?.organizationName ?? null);
    })();
  }, [id]);

  async function accept() {
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (error) {
      return setFailure(errorMessage(error));
    }
    await authClient.organization.setActive({ organizationId: data.invitation.organizationId });
    router.replace("/");
  }

  async function decline() {
    const { error } = await authClient.organization.rejectInvitation({ invitationId: id });
    if (error) {
      return setFailure(errorMessage(error));
    }
    router.replace("/");
  }

  if (organizationName === undefined) {
    return <Screen>{null}</Screen>;
  }
  return (
    <Screen title={t("title")}>
      <Text role={failure ? "alert" : undefined}>
        {failure ?? (organizationName ? t("description", { organizationName }) : t("invalid"))}
      </Text>
      {organizationName ? (
        <View className="flex-row gap-2">
          <Button onPress={accept}>
            <Text>{t("accept")}</Text>
          </Button>
          <Button variant="ghost" onPress={decline}>
            <Text>{t("decline")}</Text>
          </Button>
        </View>
      ) : null}
    </Screen>
  );
}
