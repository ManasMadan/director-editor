"use client";

import { AvatarCard } from "../components/avatar-card";
import { DemoSettingsNote, useDemoAccount } from "../components/demo-note";
import { EmailCard } from "../components/email-card";
import { ProfileCard } from "../components/profile-card";

export function ProfileSettingsPage() {
  const demo = useDemoAccount();
  return (
    <>
      {demo ? <DemoSettingsNote /> : null}
      {/* The demo keeps only its language and time zone, which are its own browser's. */}
      <ProfileCard nameLocked={demo !== false} />
      {demo === false ? (
        <>
          <AvatarCard />
          <EmailCard />
        </>
      ) : null}
    </>
  );
}
