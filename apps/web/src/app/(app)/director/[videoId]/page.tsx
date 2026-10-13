import { pageTitle } from "@/lib/metadata";
import { DirectorPage } from "@/modules/director";

export const generateMetadata = pageTitle("director.title");

export default async function Page({ params }: PageProps<"/director/[videoId]">) {
  return <DirectorPage videoId={(await params).videoId} />;
}
