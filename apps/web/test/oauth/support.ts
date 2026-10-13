/**
 * An app connecting over OAuth, as a real MCP client would: it registers itself, then
 * sends the user's browser to the authorization endpoint, which answers with the page
 * the user continues on (sign-in, or consent) carrying the signed request. Its redirect
 * URI is never loaded: going there is a full-page navigation, which tests catch.
 */
export const REDIRECT_URI = "http://127.0.0.1:9/callback";

export async function registerApp(name = "Web Agent") {
  const response = await fetch("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      application_type: "native",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (response.status !== 201) {
    throw new Error(`register answered ${response.status}`);
  }
  return ((await response.json()) as { client_id: string }).client_id;
}

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** Starts the app's authorization request; returns the page it lands on (path and query). */
export async function authorize(clientId: string) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid offline_access todos:read todos:write",
    state: "web-state",
    code_challenge: base64url(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
    code_challenge_method: "S256",
    resource: `${window.location.origin}/api/mcp`,
  });
  // Called with fetch, the endpoint answers where it would redirect.
  const response = await fetch(`/api/auth/oauth2/authorize?${query}`);
  const { url } = (await response.json()) as { url: string };
  const landed = new URL(url, window.location.origin);
  return landed.pathname + landed.search;
}
