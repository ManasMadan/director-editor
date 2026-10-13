import { pageTitle } from "@/lib/metadata";
import { ShortsPlayerPage } from "@/modules/shorts";

export const generateMetadata = pageTitle("shorts.title");

export default function Page() {
  return <ShortsPlayerPage />;
}
