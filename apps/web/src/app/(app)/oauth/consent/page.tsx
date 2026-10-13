import { Suspense } from "react";
import { pageTitle } from "@/lib/metadata";
import { OAuthConsentPage } from "@/modules/oauth";

export const generateMetadata = pageTitle("oauth.title");

// The page reads the signed request from the query string.
export default function Page() {
  return (
    <Suspense>
      <OAuthConsentPage />
    </Suspense>
  );
}
