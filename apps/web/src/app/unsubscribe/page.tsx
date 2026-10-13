import { Suspense } from "react";
import { pageTitle } from "@/lib/metadata";
import { UnsubscribePage } from "@/modules/notifications";

export const generateMetadata = pageTitle("unsubscribe.title");

// Reads ?token=, which needs a Suspense boundary for static rendering.
export default function Page() {
  return (
    <Suspense>
      <UnsubscribePage />
    </Suspense>
  );
}
