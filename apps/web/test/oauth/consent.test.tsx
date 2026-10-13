import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { SignInPage } from "@/modules/auth";
import { OAuthConsentPage } from "@/modules/oauth";
import { currentUrl, renderPage } from "../render";
import { auth, signOut, signUp } from "../users";
import { authorize, REDIRECT_URI, registerApp } from "./support";

const toasts = (page: Awaited<ReturnType<typeof renderPage>>) =>
  page.getByRole("region", { name: /^Notifications/ }).getByRole("listitem");

const answered = async () =>
  expect
    .poll(async () =>
      (await commands.hardNavigations()).find((url) => url.startsWith(REDIRECT_URI)),
    )
    .toBeTruthy();

describe("connecting an app", () => {
  it("asks which workspace and what it may do, then sends the user back with a code", async () => {
    await signUp();
    const url = await authorize(await registerApp());
    expect(url).toMatch(/^\/oauth\/consent\?/);
    const page = await renderPage(<OAuthConsentPage />, { url });
    await expect.element(page.getByRole("heading", { name: "Connect Web Agent" })).toBeVisible();
    await expect.element(page.getByText("See the workspace's todos")).toBeVisible();
    await expect
      .element(page.getByText("You'll be sent back to 127.0.0.1:9.", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Workspace" }).getByText("Personal"))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Allow" }));
    await answered();
    const back = new URL((await commands.hardNavigations()).at(-1) as string);
    expect(back.searchParams.get("state")).toBe("web-state");
    expect(back.searchParams.get("code")).toBeTruthy();
  });

  it("can be denied", async () => {
    await signUp();
    const page = await renderPage(<OAuthConsentPage />, {
      url: await authorize(await registerApp()),
    });
    await expect.element(page.getByRole("heading", { name: "Connect Web Agent" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Deny" }));
    await answered();
    expect(
      new URL((await commands.hardNavigations()).at(-1) as string).searchParams.get("error"),
    ).toBe("access_denied");
  });

  it("works in another workspace once the user picks it", async () => {
    await signUp();
    const team = `Team ${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await auth<{ id: string }>("/organization/create", {
      name: team,
      slug: `team-${crypto.randomUUID().slice(0, 8)}`,
    });
    await auth("/organization/set-active", { organizationId: workspace.id });
    const page = await renderPage(<OAuthConsentPage />, {
      url: await authorize(await registerApp()),
    });
    const choice = page.getByRole("combobox", { name: "Workspace" });
    await expect.element(choice.getByText(team)).toBeVisible();
    // Picking the one it's already in changes nothing.
    await userEvent.click(choice);
    await userEvent.click(page.getByRole("option", { name: team }));
    await expect.element(page.getByRole("option", { name: team })).not.toBeInTheDocument();
    expect(await commands.hardNavigations()).toEqual([]);
    await userEvent.click(choice);
    await userEvent.click(page.getByRole("option", { name: "Personal" }));
    await expect.poll(async () => (await commands.hardNavigations()).length).toBeGreaterThan(0);
  });

  it("says when the workspace couldn't be switched", async () => {
    await signUp();
    const gone = await auth<{ id: string }>("/organization/create", {
      name: "Gone team",
      slug: `team-${crypto.randomUUID().slice(0, 8)}`,
      keepCurrentActiveOrganization: true,
    });
    const page = await renderPage(<OAuthConsentPage />, {
      url: await authorize(await registerApp()),
    });
    const choice = page.getByRole("combobox", { name: "Workspace" });
    await expect.element(choice.getByText("Personal")).toBeVisible();
    // Deleted from another tab after this page listed it.
    await auth("/organization/delete", { organizationId: gone.id });
    await userEvent.click(choice);
    await userEvent.click(page.getByRole("option", { name: "Gone team" }));
    await expect.element(toasts(page)).toHaveTextContent("Something went wrong. Please try again.");
    await expect.element(choice).toBeEnabled();
    expect(await commands.hardNavigations()).toEqual([]);
  });

  it("refuses a request that was changed on the way, showing it as it came", async () => {
    await signUp();
    const url = new URL(await authorize(await registerApp()), window.location.origin);
    url.searchParams.set("scope", "openid custom:scope");
    url.searchParams.set("redirect_uri", "not a url");
    const page = await renderPage(<OAuthConsentPage />, { url: url.pathname + url.search });
    await expect.element(page.getByText("custom:scope")).toBeVisible();
    expect(page.getByText("You'll be sent back to", { exact: false }).query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Allow" }));
    await expect
      .element(page.getByText("The app's request expired. Go back to the app and connect again."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Allow" })).toBeEnabled();
    expect((await commands.hardNavigations()).some((to) => to.startsWith(REDIRECT_URI))).toBe(
      false,
    );
  });

  it("names an unknown app generically, and a page opened without a request says so", async () => {
    await signUp();
    const page = await renderPage(<OAuthConsentPage />, {
      url: `/oauth/consent?client_id=${crypto.randomUUID()}&sig=forged`,
    });
    await expect.element(page.getByRole("heading", { name: "Connect An app" })).toBeVisible();
    const missing = await renderPage(<OAuthConsentPage />, { url: "/oauth/consent" });
    await expect
      .element(missing.getByText("This page opens when an app asks to connect", { exact: false }))
      .toBeVisible();
  });

  it("waits for the session before choosing a workspace", async () => {
    // Signed out (the proxy would send this visitor to sign in first).
    const request = new URL(await authorize(await registerApp()), window.location.origin);
    const page = await renderPage(<OAuthConsentPage />, { url: `/oauth/consent${request.search}` });
    await expect.element(page.getByRole("heading", { name: /^Connect / })).toBeVisible();
  });

  it("continues the app's request after signing in, instead of going to the dashboard", async () => {
    const user = await signUp();
    await signOut();
    const url = await authorize(await registerApp());
    expect(url).toMatch(/^\/sign-in\?.*client_id=.*sig=/);
    const page = await renderPage(<SignInPage />, { url });
    await userEvent.fill(page.getByLabelText("Email"), user.email);
    await userEvent.fill(page.getByLabelText("Password"), user.password);
    await userEvent.click(page.getByRole("button", { name: "Sign in", exact: true }));
    await expect
      .poll(async () => (await commands.hardNavigations()).at(-1))
      .toMatch(/\/oauth\/consent\?.*client_id=/);
    expect(currentUrl()).toBe(url);
  });
});
