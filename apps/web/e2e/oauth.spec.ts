/**
 * An app (an MCP client) connecting over OAuth, in a real browser: signing in or up from
 * the app's request, the consent page (workspace choice, allow, deny), and managing
 * connected apps. The app's side (registration, the token exchange) is done with plain
 * requests, as a real client would; its redirect URI is answered by a stub page.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import {
  BASE_URL,
  createWorkspace,
  enableTwoFactor,
  expect,
  mailbox,
  newDevice,
  newUser,
  signIn,
  signOut,
  signUp,
  test,
  totp,
} from "./support";

const MCP_RESOURCE = `${BASE_URL}/api/mcp`;

// The app's redirect URI: a loopback server (what a desktop MCP client runs) per worker.
let callbackServer: Server;
let REDIRECT_URI: string;
test.beforeAll(async () => {
  callbackServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<h1>Back in the app</h1>");
  });
  await new Promise<void>((resolve) => callbackServer.listen(0, "127.0.0.1", resolve));
  REDIRECT_URI = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}/callback`;
});
test.afterAll(() => new Promise((resolve) => callbackServer.close(resolve)));

async function registerClient(page: Page, name = "E2E Agent") {
  const response = await page.request.post("/api/auth/oauth2/register", {
    data: {
      client_name: name,
      application_type: "native",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Starts the app's authorization request in the browser; returns what the app needs later. */
async function startAuthorization(
  page: Page,
  clientId: string,
  params: { scope?: string; resource?: string } = {},
) {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: params.scope ?? "openid offline_access todos:read todos:write",
    state: "e2e-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: params.resource ?? MCP_RESOURCE,
  });
  await page.goto(`/api/auth/oauth2/authorize?${query}`);
  return { verifier };
}

/** The answer the app received on its redirect URI. */
async function callback(page: Page) {
  await page.waitForURL(`${REDIRECT_URI}**`);
  return new URL(page.url()).searchParams;
}

async function exchange(page: Page, clientId: string, code: string, verifier: string) {
  const response = await page.request.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_RESOURCE,
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const { access_token } = (await response.json()) as { access_token: string };
  const [, payload] = access_token.split(".");
  return JSON.parse(Buffer.from(payload as string, "base64url").toString()) as {
    org: string;
    scope: string;
  };
}

const consent = (page: Page) => page.getByRole("heading", { name: /^Connect / });

test("a signed-out user signs in from the app's request, then allows it", async ({ page }) => {
  const user = await signUp(page);
  await signOut(page, user);
  const clientId = await registerClient(page);
  const { verifier } = await startAuthorization(page, clientId);

  await signIn(page, user, { expectUrl: /\/oauth\/consent/ });
  await expect(consent(page)).toHaveText("Connect E2E Agent");
  await expect(page.getByText("See the workspace's todos")).toBeVisible();
  await expect(page.getByText("Add, complete and delete the workspace's todos")).toBeVisible();
  await expect(
    page.getByText(`You'll be sent back to ${new URL(REDIRECT_URI).host}.`),
  ).toBeVisible();
  const inbox = await mailbox(user.email);
  await page.getByRole("button", { name: "Allow" }).click();

  const answer = await callback(page);
  expect(answer.get("state")).toBe("e2e-state");
  const claims = await exchange(page, clientId, answer.get("code") as string, verifier);
  expect(claims.scope.split(" ")).toEqual(expect.arrayContaining(["todos:read", "todos:write"]));

  // The owner is told, by email, that an app was connected.
  expect((await inbox.next()).Subject).toBe("An app was connected to your account");
});

test("a new user signs up and verifies their email from the app's request", async ({ page }) => {
  const clientId = await registerClient(page);
  await startAuthorization(page, clientId);
  await expect(page).toHaveURL(/\/sign-in\?.*client_id=/);
  // Every auth step keeps the app's request.
  await page.getByRole("link", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/sign-up\?.*sig=/);
  await signUp(page, newUser(), { expectUrl: /\/oauth\/consent/ });
  await expect(consent(page)).toHaveText("Connect E2E Agent");
});

test("a user with two-step verification signs in from the app's request", async ({
  page,
  browser,
}) => {
  const user = await signUp(page);
  const { secret } = await enableTwoFactor(page, user);
  const laptop = await newDevice(browser);
  const clientId = await registerClient(laptop.page);
  await startAuthorization(laptop.page, clientId);
  await signIn(laptop.page, user, { expectUrl: /\/two-factor\?.*sig=/ });
  await laptop.page.getByLabel("Verification code").fill(totp(secret));
  await laptop.page.getByRole("button", { name: "Continue" }).click();
  await expect(consent(laptop.page)).toHaveText("Connect E2E Agent");
  await laptop.context.close();
});

test("denying sends the app an access_denied answer", async ({ page }) => {
  await signUp(page);
  const clientId = await registerClient(page);
  await startAuthorization(page, clientId);
  // The page is interactive once it names the app; a click before that went nowhere.
  await expect(consent(page)).toHaveText("Connect E2E Agent");
  await page.getByRole("button", { name: "Deny" }).click();
  const answer = await callback(page);
  expect(answer.get("error")).toBe("access_denied");
  expect(answer.get("code")).toBeNull();
});

test("the app works only in the workspace chosen on the consent page", async ({ page }) => {
  const user = await signUp(page);
  await createWorkspace(page, "Acme");
  const clientId = await registerClient(page);
  const { verifier } = await startAuthorization(page, clientId);
  const workspace = page.getByRole("combobox", { name: "Workspace" });
  await expect(workspace).toContainText("Acme");

  // Switching re-runs the request for the other workspace (a fresh consent page).
  await workspace.click();
  await page.getByRole("option", { name: "Personal" }).click();
  await expect(page.getByRole("combobox", { name: "Workspace" })).toContainText("Personal");
  await page.getByRole("button", { name: "Allow" }).click();
  const answer = await callback(page);
  const claims = await exchange(page, clientId, answer.get("code") as string, verifier);

  await page.goto("/settings/security");
  const apps = page.locator("[data-slot=card]", { hasText: "Connected apps" });
  await expect(apps.getByText("E2E Agent")).toBeVisible();
  await expect(apps.getByText(new RegExp(`^${user.name} · connected`))).toBeVisible();
  expect(claims.org).toBeTruthy();
});

test("disconnecting an app removes it, and it has to ask again", async ({ page }) => {
  await signUp(page);
  const clientId = await registerClient(page, "Disconnect Me");
  await startAuthorization(page, clientId);
  await page.getByRole("button", { name: "Allow" }).click();
  await callback(page);

  await page.goto("/settings/security");
  const apps = page.locator("[data-slot=card]", { hasText: "Connected apps" });
  await apps.getByRole("button", { name: "Disconnect: Disconnect Me" }).click();
  await expect(page.getByText("Disconnect Me was disconnected")).toBeVisible();
  await expect(apps.getByText("No apps are connected.")).toBeVisible();

  await startAuthorization(page, clientId);
  await expect(consent(page)).toHaveText("Connect Disconnect Me");
});

test("an approved app is sent straight back next time", async ({ page }) => {
  await signUp(page);
  const clientId = await registerClient(page);
  await startAuthorization(page, clientId);
  await page.getByRole("button", { name: "Allow" }).click();
  await callback(page);
  await startAuthorization(page, clientId);
  expect((await callback(page)).get("code")).toBeTruthy();
});

test("an altered or expired request is refused with an explanation", async ({ page }) => {
  await signUp(page);
  const clientId = await registerClient(page);
  await startAuthorization(page, clientId);
  await expect(consent(page)).toBeVisible();
  const url = new URL(page.url());
  url.searchParams.set("scope", "openid todos:read todos:write documents:read");
  await page.goto(url.toString());
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(
    page.getByText("The app's request expired. Go back to the app and connect again."),
  ).toBeVisible();
  expect(page.url()).toContain("/oauth/consent");
});

test("the consent page explains itself when opened directly", async ({ page }) => {
  await signUp(page);
  await page.goto("/oauth/consent");
  await expect(
    page.getByText("This page opens when an app asks to connect to your account."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);
});

test("the consent page needs a session", async ({ page }) => {
  await page.goto("/oauth/consent?client_id=x&sig=y");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
});

test("the AI service's MCP server accepts the api's tokens for it", async ({ page }) => {
  await signUp(page);
  const clientId = await registerClient(page);
  const aiResource = `${BASE_URL}/ai/mcp`;
  const { verifier } = await startAuthorization(page, clientId, {
    scope: "openid documents:read",
    resource: aiResource,
  });
  await expect(page.getByText("Search the workspace's documents")).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  const code = (await callback(page)).get("code") as string;
  const tokens = await page.request.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: aiResource,
    },
  });
  const { access_token } = (await tokens.json()) as { access_token: string };
  const tools = await page.request.post("/ai/mcp", {
    headers: {
      authorization: `Bearer ${access_token}`,
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  expect(tools.status(), await tools.text()).toBe(200);
  const names = (
    (await tools.json()) as { result: { tools: { name: string }[] } }
  ).result.tools.map((tool) => tool.name);
  expect(names.sort()).toEqual(["list_documents", "search_documents"]);
  // The api's MCP server doesn't take a token meant for the AI service.
  const api = await page.request.post("/api/mcp", {
    headers: {
      authorization: `Bearer ${access_token}`,
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  expect(api.status()).toBe(401);
});

test("MCP clients discover everything on the site's origin", async ({ request }) => {
  const get = async (path: string) => {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };
  const issuer = `${BASE_URL}/api/auth`;
  expect(await get("/.well-known/oauth-authorization-server/api/auth")).toMatchObject({ issuer });
  expect(await get("/.well-known/oauth-protected-resource/api/mcp")).toMatchObject({
    resource: `${BASE_URL}/api/mcp`,
    authorization_servers: [issuer],
  });
  expect(await get("/.well-known/oauth-protected-resource/ai/mcp")).toMatchObject({
    resource: `${BASE_URL}/ai/mcp`,
    authorization_servers: [issuer],
  });
  // An unauthenticated call is answered with the challenge that starts it all.
  const challenge = await request.post("/ai/mcp", { data: {} });
  expect(challenge.status()).toBe(401);
  expect(challenge.headers()["www-authenticate"]).toContain(
    `${BASE_URL}/.well-known/oauth-protected-resource/ai/mcp`,
  );
});
