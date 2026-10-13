import { pageTitle } from "@/lib/metadata";
import { WebhookEndpointPage } from "@/modules/workspace";

export const generateMetadata = pageTitle("workspace.webhooks.title");

export default async function Page({ params }: PageProps<"/settings/webhooks/[id]">) {
  return <WebhookEndpointPage id={(await params).id} />;
}
