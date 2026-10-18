import { pageTitle } from "@/lib/metadata";
import { CreatedPage } from "@/modules/director";

export const generateMetadata = pageTitle("create.plan.title");

export default async function Page({ params }: PageProps<"/create/[videoId]">) {
  return <CreatedPage videoId={(await params).videoId} />;
}
