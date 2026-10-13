import { pageTitle } from "@/lib/metadata";
import { LegalPage } from "@/modules/marketing";

export const generateMetadata = pageTitle("legal.terms");

export default function Page() {
  return <LegalPage document="terms" />;
}
