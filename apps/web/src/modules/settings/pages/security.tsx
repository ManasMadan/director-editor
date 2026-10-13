import { ConnectedAppsCard } from "../components/connected-apps-card";
import { DeleteAccountCard } from "../components/delete-account-card";
import { PasskeysCard } from "../components/passkeys-card";
import { PasswordCard } from "../components/password-card";
import { PhoneCard } from "../components/phone-card";
import { SessionsCard } from "../components/sessions-card";
import { TwoFactorCard } from "../components/two-factor-card";

export function SecuritySettingsPage() {
  return (
    <>
      <SessionsCard />
      <TwoFactorCard />
      <PasskeysCard />
      <PhoneCard />
      <ConnectedAppsCard />
      <PasswordCard />
      <DeleteAccountCard />
    </>
  );
}
