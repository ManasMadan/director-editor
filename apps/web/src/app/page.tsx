import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";
import { HomePage } from "@/modules/marketing";

export default async function Page() {
  // Only whether a session cookie is there, to pick the call to action; the API decides
  // whether the session is valid.
  return <HomePage signedIn={getSessionCookie(await headers()) !== null} />;
}
