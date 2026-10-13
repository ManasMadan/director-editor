import { pageTitle } from "@/lib/metadata";
import { LegalPage } from "@/modules/marketing";

export const generateMetadata = pageTitle("legal.privacy");

export default function Page() {
  return <LegalPage document="privacy" />;
}
