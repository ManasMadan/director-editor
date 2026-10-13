import { pageTitle } from "@/lib/metadata";
import { InvitationPage } from "@/modules/invitations";

export const generateMetadata = pageTitle("invitations.title");

export default async function Page({ params }: PageProps<"/invitations/[id]">) {
  return <InvitationPage id={(await params).id} />;
}
