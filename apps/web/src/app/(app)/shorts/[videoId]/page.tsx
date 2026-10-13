import { pageTitle } from "@/lib/metadata";
import { ShortsPlayerPage } from "@/modules/shorts";

export const generateMetadata = pageTitle("shorts.title");

export default async function Page({ params }: PageProps<"/shorts/[videoId]">) {
  return <ShortsPlayerPage videoId={(await params).videoId} />;
}
