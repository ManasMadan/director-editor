import { useTranslations } from "use-intl";
import { Screen } from "@/components/screen";

/** Shown when the API no longer supports this build (CLIENT_OUTDATED). */
export default function UpdateRequired() {
  const t = useTranslations("updateRequired");
  return (
    <Screen title={t("title")} description={t("description")}>
      {null}
    </Screen>
  );
}
