import { Suspense } from "react";
import { pageTitle } from "@/lib/metadata";
import { CaptchaPage } from "@/modules/auth";

export const generateMetadata = pageTitle("captcha.title");

// Reads ?return_to=, which needs a Suspense boundary for static rendering.
export default function Page() {
  return (
    <Suspense>
      <CaptchaPage />
    </Suspense>
  );
}
