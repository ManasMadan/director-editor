"use client";

import { DeleteAccountCard } from "../components/delete-account-card";
import { DemoSettingsNote, useDemoAccount } from "../components/demo-note";
import { PasskeysCard } from "../components/passkeys-card";
import { PasswordCard } from "../components/password-card";
import { SessionsCard } from "../components/sessions-card";
import { TwoFactorCard } from "../components/two-factor-card";

export function SecuritySettingsPage() {
  const demo = useDemoAccount();
  return (
    <>
      {demo ? <DemoSettingsNote /> : null}
      {/* The demo's device list shows only this device, so there's nothing to sign out. */}
      <SessionsCard />
      {demo === false ? (
        <>
          <TwoFactorCard />
          <PasskeysCard />
          <PasswordCard />
          <DeleteAccountCard />
        </>
      ) : null}
    </>
  );
}
