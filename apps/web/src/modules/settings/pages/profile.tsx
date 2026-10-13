import { AvatarCard } from "../components/avatar-card";
import { EmailCard } from "../components/email-card";
import { ProfileCard } from "../components/profile-card";

export function ProfileSettingsPage() {
  return (
    <>
      <ProfileCard />
      <AvatarCard />
      <EmailCard />
    </>
  );
}
