import { useApiErrorMessage } from "@repo/client";
import { useRegisterDeviceMutation } from "@repo/client/api/notifications/register-device";
import { authErrorKey } from "@repo/client/auth/errors";
import { usePasskeysQuery } from "@repo/client/auth/passkeys";
import { authKeys } from "@repo/client/auth/query";
import { useWorkspacesQuery } from "@repo/client/auth/workspaces";
import { type Locale, locales } from "@repo/i18n/locales";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { useAuthErrorMessage } from "@/hooks/use-auth";
import { authClient } from "@/lib/auth-client";
import { appVersion } from "@/lib/config";
import { addPasskey, passkeysSupported } from "@/lib/passkeys";
import { devicePushToken, type PushState, pushState } from "@/lib/push";

export default function Settings() {
  const t = useTranslations("mobile");
  const common = useTranslations("common");
  const errorMessage = useApiErrorMessage();
  const queryClient = useQueryClient();
  const { data: session, refetch } = authClient.useSession();
  const workspaces = useWorkspacesQuery(authClient);
  const [failure, setFailure] = useState<string>();

  async function switchWorkspace(organizationId: string) {
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) {
      return setFailure(errorMessage(error));
    }
    await refetch();
    // Every cached query belonged to the previous workspace.
    await queryClient.invalidateQueries();
  }

  async function setLanguage(locale: Locale) {
    const { error } = await authClient.updateUser({ locale });
    if (error) {
      return setFailure(errorMessage(error));
    }
    await refetch();
  }

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    router.replace("/sign-in");
  }

  const activeId = session?.session.activeOrganizationId;
  return (
    <Screen title={common("settings")}>
      {failure ? (
        <Text role="alert" className="text-destructive">
          {failure}
        </Text>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.account")}</CardTitle>
        </CardHeader>
        <CardContent className="gap-3">
          <Text>{t("settings.signedInAs", { email: session?.user.email ?? "" })}</Text>
          <Button variant="outline" onPress={signOut}>
            <Text>{common("signOut")}</Text>
          </Button>
        </CardContent>
      </Card>
      <Passkeys onFailure={setFailure} onSignInAgain={signOut} />
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.workspace")}</CardTitle>
        </CardHeader>
        <CardContent className="gap-2" role="radiogroup" aria-label={t("settings.workspace")}>
          {workspaces.data?.map((workspace) => (
            <Button
              key={workspace.id}
              role="radio"
              aria-checked={workspace.id === activeId}
              variant={workspace.id === activeId ? "default" : "outline"}
              onPress={() => workspace.id !== activeId && switchWorkspace(workspace.id)}
            >
              <Text>{workspace.name}</Text>
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.language")}</CardTitle>
        </CardHeader>
        <CardContent
          className="flex-row gap-2"
          role="radiogroup"
          aria-label={t("settings.language")}
        >
          {locales.map((locale) => (
            <Button
              key={locale}
              role="radio"
              aria-checked={session?.user.locale === locale}
              variant={session?.user.locale === locale ? "default" : "outline"}
              onPress={() => setLanguage(locale)}
            >
              <Text>{t(`languages.${locale}`)}</Text>
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.notifications")}</CardTitle>
        </CardHeader>
        <CardContent className="gap-3">
          <PushStatus onFailure={setFailure} />
        </CardContent>
      </Card>
      <View className="items-center">
        <Text className="text-sm text-muted-foreground">
          {t("settings.version", { version: appVersion })}
        </Text>
      </View>
    </Screen>
  );
}

/** The account's passkeys, as in the web app's security settings: add one here, remove any. */
function Passkeys({
  onFailure,
  onSignInAgain,
}: {
  onFailure: (message: string) => void;
  onSignInAgain: () => void;
}) {
  const t = useTranslations("settings.security");
  const format = useFormatter();
  const errorMessage = useAuthErrorMessage();
  const queryClient = useQueryClient();
  const passkeys = usePasskeysQuery(authClient);
  const [staleSession, setStaleSession] = useState(false);
  const [added, setAdded] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: authKeys.passkeys() });

  async function add() {
    setAdded(false);
    const { error } = await addPasskey();
    if (error) {
      // Adding one needs a recent sign-in (the API's fresh-session window).
      if (authErrorKey(error) === "SESSION_EXPIRED") {
        setStaleSession(true);
      } else {
        onFailure(errorMessage(error));
      }
      return;
    }
    await refresh();
    setAdded(true);
  }

  async function remove(id: string) {
    const { error } = await authClient.passkey.deletePasskey({ id });
    if (error) {
      onFailure(errorMessage(error));
    }
    await refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("passkeys.title")}</CardTitle>
      </CardHeader>
      <CardContent className="gap-3">
        <Text className="text-muted-foreground">{t("passkeys.description")}</Text>
        {passkeys.data?.length === 0 ? (
          <Text className="text-muted-foreground">{t("passkeys.empty")}</Text>
        ) : null}
        {passkeys.data?.map((passkey) => (
          <View key={passkey.id} className="flex-row items-center justify-between gap-3">
            <View>
              <Text>{passkey.name ?? t("passkeys.unnamed")}</Text>
              {passkey.createdAt ? (
                <Text className="text-sm text-muted-foreground">
                  {format.dateTime(new Date(passkey.createdAt), { dateStyle: "medium" })}
                </Text>
              ) : null}
            </View>
            <Button variant="outline" size="sm" onPress={() => remove(passkey.id)}>
              <Text>{t("passkeys.remove")}</Text>
            </Button>
          </View>
        ))}
        {added ? <Text role="status">{t("passkeys.added")}</Text> : null}
        {staleSession ? (
          <View className="gap-2">
            <Text className="font-medium">{t("reauth.title")}</Text>
            <Text className="text-muted-foreground">{t("reauth.body")}</Text>
            <Button onPress={onSignInAgain}>
              <Text>{t("reauth.action")}</Text>
            </Button>
          </View>
        ) : null}
        {!staleSession && passkeysSupported() ? (
          <Button variant="outline" onPress={add}>
            <Text>{t("passkeys.add")}</Text>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Where push notifications stand on this device, or the button that turns them on. */
function PushStatus({ onFailure }: { onFailure: (message: string) => void }) {
  const t = useTranslations("mobile");
  const errorMessage = useApiErrorMessage();
  const register = useRegisterDeviceMutation();
  const [push, setPush] = useState<PushState>();

  useEffect(() => {
    void pushState().then(setPush);
  }, []);

  async function onEnable() {
    const device = await devicePushToken();
    setPush(await pushState());
    if (device) {
      register.mutate(
        { device, appVersion },
        { onError: (error) => onFailure(errorMessage(error)) },
      );
    }
  }

  if (push === "unavailable") {
    return <Text className="text-muted-foreground">{t("settings.pushUnavailable")}</Text>;
  }
  if (push === "denied") {
    return <Text className="text-muted-foreground">{t("settings.pushDenied")}</Text>;
  }
  if (push === "granted" && register.isSuccess) {
    return <Text>{t("settings.pushEnabled")}</Text>;
  }
  return (
    <Button onPress={onEnable} disabled={register.isPending || push === undefined}>
      <Text>{t("settings.enablePush")}</Text>
    </Button>
  );
}
