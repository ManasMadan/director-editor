import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { SignInPage } from "@/modules/auth";
import { DEMO } from "../demo";
import { cleanup, currentUrl, renderPage, router } from "../render";
import { auth, currentSession, enableTwoFactor, newUser, signOut, signUp } from "../users";

/** system.info as the full API answers it, changed to an environment it isn't running as. */
interface SystemInfo {
  features: { demoGuests: boolean; captcha: boolean };
  demo: { email: string; password: string } | null;
  captchaSiteKey: string | null;
}

/**
 * system.info as it would be with captcha on too. The full API itself has it off, so it
 * takes the guest sign-in with or without the token: what's checked is that the page
 * sends one, and waits for it.
 */
const withCaptcha = (info: SystemInfo) => {
  info.features.captcha = true;
  info.captchaSiteKey = "1x00000000000000000000AA";
};

/** Answers the page's system.info with the full API's own answer, after `change`. */
async function serveSystemInfo(change: (info: SystemInfo) => void) {
  const answer = await fetch("/rpc/system/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json() as Promise<{ json: SystemInfo }>);
  change(answer.json);
  await commands.failRequests("/rpc/system/info", { status: 200, body: answer });
}

async function fillIn(
  page: Awaited<ReturnType<typeof renderPage>>,
  email: string,
  password: string,
) {
  await userEvent.fill(page.getByLabelText("Email"), email);
  await userEvent.fill(page.getByLabelText("Password"), password);
  await userEvent.click(page.getByRole("button", { name: "Sign in", exact: true }));
}

describe("sign in", () => {
  it("signs in with email and password and continues to ?next=", async () => {
    const user = await signUp();
    await signOut();
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/settings" });
    await fillIn(page, user.email, user.password);
    await expect.poll(currentUrl).toBe("/settings");
    expect(router.refreshes).toBe(1);
    expect(await commands.hardNavigations()).toEqual([]);
  });

  it("says when the password is wrong, and checks the form first", async () => {
    const user = await signUp();
    await signOut();
    const page = await renderPage(<SignInPage />, { url: "/sign-in" });
    await userEvent.click(page.getByRole("button", { name: "Sign in", exact: true }));
    await expect.element(page.getByText("Enter a valid email address")).toBeVisible();
    await fillIn(page, user.email, "not-the-password");
    await expect.element(page.getByText("That email and password don't match.")).toBeVisible();
    expect(currentUrl()).toBe("/sign-in");
  });

  it("sends an unverified account to verify its email, keeping the query", async () => {
    const user = newUser();
    await auth("/sign-up/email", user);
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/settings" });
    await fillIn(page, user.email, user.password);
    await expect
      .poll(currentUrl)
      .toBe(`/verify-email?next=%2Fsettings&email=${encodeURIComponent(user.email)}`);
  });

  it("continues on the two-step page when the account has it on", async () => {
    const user = await signUp();
    await enableTwoFactor(user);
    await signOut();
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/settings" });
    await fillIn(page, user.email, user.password);
    await expect
      .poll(commands.hardNavigations)
      .toEqual([`${window.location.origin}/two-factor?next=/settings`]);
    expect(currentUrl()).toBe("/sign-in?next=/settings");
  });

  it("signs in with a passkey, and says so when the prompt is dismissed", async () => {
    await commands.virtualAuthenticator();
    await signUp();
    const { authClient } = await import("@/lib/auth-client");
    expect((await authClient.passkey.addPasskey()).error).toBeFalsy();
    await signOut();
    const page = await renderPage(<SignInPage />, { url: "/sign-in" });
    await userEvent.click(page.getByRole("button", { name: "Sign in with a passkey" }));
    await expect.poll(currentUrl).toBe("/library");

    // A fresh authenticator has no passkey for this site: the prompt ends without one.
    cleanup();
    await signOut();
    await commands.virtualAuthenticator();
    const again = await renderPage(<SignInPage />, { url: "/sign-in" });
    await userEvent.click(again.getByRole("button", { name: "Sign in with a passkey" }));
    await expect
      .element(again.getByText("The passkey prompt was closed before finishing.", { exact: false }))
      .toBeVisible();
  });

  it("offers Google when it's on, and goes there with ?next= as the way back", async () => {
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/settings" });
    await userEvent.click(
      page.getByRole("button", { name: "Continue with Google, to post to your channel" }),
    );
    await expect
      .poll(async () => (await commands.hardNavigations())[0])
      .toMatch(
        /^https:\/\/accounts\.google\.com\/.*client_id=web-tests\.apps\.googleusercontent\.com/,
      );
  });

  it("offers the demo as a guest of this browser's own, and signs in as one", async () => {
    const page = await renderPage(<SignInPage />, { url: "/sign-in" });
    const card = page.getByRole("region", { name: "Just looking? Use the demo." });
    await expect
      .element(
        card.getByText("Your footage is deleted after a day, and posting to YouTube is off."),
      )
      .toBeVisible();
    // The shared account's password stays out of sight while guests are given out.
    expect(page.getByText(DEMO.password).elements()).toHaveLength(0);

    await userEvent.click(card.getByRole("button", { name: "Use the demo" }));
    await expect.poll(currentUrl).toBe("/library");
    const { user } = await currentSession();
    expect(user).toMatchObject({ name: "Guest", demo: true });
    expect(user.email).toMatch(/@guest\.invalid$/);
  });

  it("starts the guest at once from ?demo=1, the landing page's link", async () => {
    await renderPage(<SignInPage />, { url: "/sign-in?demo=1&next=/director/22k0fZarxh8" });
    await expect.poll(currentUrl).toBe("/director/22k0fZarxh8");
    expect((await currentSession()).user.demo).toBe(true);
  });

  // First of the captcha tests: Turnstile's script loads once a page, and once it has, it
  // can't be blocked any more. A failed load is forgotten, so the next test loads it again.
  it("falls back to the shared demo account when Turnstile can't load", async () => {
    await serveSystemInfo(withCaptcha);
    await commands.turnstile("blocked");
    const page = await renderPage(<SignInPage />, { url: "/sign-in?demo=1" });
    await expect
      .element(page.getByText("Your own demo couldn't start just now.", { exact: false }))
      .toBeVisible();
    // One notice, not a second one about the check contradicting it.
    expect(page.getByRole("alert").elements()).toHaveLength(1);
    const card = page.getByRole("region", { name: "Try Director with the demo account" });
    await expect.element(card.getByText(DEMO.password)).toBeVisible();
    await expect.element(page.getByLabelText("Email")).toHaveValue(DEMO.email);
    await expect.element(page.getByLabelText("Password")).toHaveValue(DEMO.password);
    expect(await commands.sentHeaders("/api/auth/sign-in/guest")).toEqual([]);
  });

  // Next: this one needs the script still on its way.
  it("waits for Turnstile's token before starting the guest from ?demo=1", async () => {
    await serveSystemInfo(withCaptcha);
    await commands.turnstile("held");
    await renderPage(<SignInPage />, { url: "/sign-in?demo=1" });
    await expect
      .poll(() => document.head.querySelector('script[src*="challenges.cloudflare.com"]'))
      .toBeTruthy();
    expect(await commands.sentHeaders("/api/auth/sign-in/guest")).toEqual([]);
    expect(currentUrl()).toBe("/sign-in?demo=1");
    await commands.turnstile("fake");
    await expect.poll(currentUrl).toBe("/library");
    const [sent] = await commands.sentHeaders("/api/auth/sign-in/guest");
    expect(sent?.["x-captcha-response"]).toBe("XXXX.DUMMY.TOKEN.XXXX");
  });

  it("sends the guest sign-in Turnstile's token, with the widget out of sight", async () => {
    await serveSystemInfo(withCaptcha);
    const page = await renderPage(<SignInPage />, { url: "/sign-in" });
    const card = page.getByRole("region", { name: "Just looking? Use the demo." });
    // Out of sight unless Cloudflare wants an interaction: still one tap.
    await expect
      .element(page.getByTestId("captcha"))
      .toHaveAttribute("data-appearance", "interaction-only");
    // In the page's own theme, not a light box whatever the page.
    await expect
      .element(page.getByTestId("captcha"))
      .toHaveAttribute(
        "data-theme",
        document.documentElement.classList.contains("dark") ? "dark" : "light",
      );
    const start = card.getByRole("button", { name: "Use the demo" });
    await expect.element(start).toBeEnabled();
    await userEvent.click(start);
    await expect.poll(currentUrl).toBe("/library");
    const [sent] = await commands.sentHeaders("/api/auth/sign-in/guest");
    expect(sent?.["x-captcha-response"]).toBe("XXXX.DUMMY.TOKEN.XXXX");
  });

  it("stops waiting for a token that never comes, and says why", { timeout: 20_000 }, async () => {
    // No shared account to fall back on, this time: the card stays, and says what's wrong.
    await serveSystemInfo((info) => {
      withCaptcha(info);
      info.demo = null;
    });
    Object.assign(window, { turnstileSilent: true });
    try {
      const page = await renderPage(<SignInPage />, { url: "/sign-in?demo=1" });
      await expect
        .element(page.getByRole("alert"), { timeout: 12_000 })
        // The widget did load: it's waiting, so the page doesn't say it couldn't load.
        .toHaveTextContent(
          "The security check didn't finish. If it shows a box, tap it, or reload the page to try again.",
        );
      const card = page.getByRole("region", { name: "Just looking? Use the demo." });
      await expect.element(card.getByRole("button", { name: "Use the demo" })).toBeDisabled();
      expect(await commands.sentHeaders("/api/auth/sign-in/guest")).toEqual([]);
    } finally {
      Object.assign(window, { turnstileSilent: false });
    }
  });

  it("falls back to the shared account with one notice when the check stalls", {
    timeout: 20_000,
  }, async () => {
    await serveSystemInfo(withCaptcha);
    Object.assign(window, { turnstileSilent: true });
    try {
      const page = await renderPage(<SignInPage />, { url: "/sign-in?demo=1" });
      const card = page.getByRole("region", { name: "Try Director with the demo account" });
      await expect.element(card, { timeout: 12_000 }).toBeVisible();
      // The widget loaded and waits: nothing says it couldn't load, and the fallback says why.
      expect(page.getByRole("alert").elements()).toHaveLength(1);
      await expect
        .element(page.getByRole("alert"))
        .toMatchTextContent(/^Your own demo couldn't start just now\./);
    } finally {
      Object.assign(window, { turnstileSilent: false });
    }
  });

  it("greets a visitor from the landing page's demo link as one trying it, not as a member", async () => {
    // Held on this page (no guest to be had), where the greeting can be read.
    await commands.failRequests("/api/auth/sign-in/guest", {
      status: 503,
      body: { code: "DEMO_GUESTS_FULL", message: "Full." },
    });
    const page = await renderPage(<SignInPage />, { url: "/sign-in?demo=1" });
    await expect.element(page.getByText("Try Director, no sign-up")).toBeVisible();
    expect(page.getByText("Welcome back").query()).toBeNull();
    cleanup();
    const member = await renderPage(<SignInPage />, { url: "/sign-in" });
    await expect.element(member.getByText("Welcome back")).toBeVisible();
  });

  it("falls back to the shared demo account, in the form, when no guest can be made", async () => {
    await commands.failRequests("/api/auth/sign-in/guest", {
      status: 503,
      body: { code: "DEMO_GUESTS_FULL", message: "Full." },
    });
    const page = await renderPage(<SignInPage />, { url: "/sign-in?demo=1" });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Your own demo couldn't start just now. The shared demo account below works too, but anyone trying Director can see what's filmed in it.",
      );
    const card = page.getByRole("region", { name: "Try Director with the demo account" });
    await expect.element(card.getByText(DEMO.password)).toBeVisible();
    await expect.element(page.getByLabelText("Email")).toHaveValue(DEMO.email);
    await expect.element(page.getByLabelText("Password")).toHaveValue(DEMO.password);
    expect(currentUrl()).toBe("/sign-in?demo=1");
  });

  it("says why when no guest can be made and there's no shared account", async () => {
    await serveSystemInfo((info) => {
      info.demo = null;
    });
    await commands.failRequests("/api/auth/sign-in/guest", {
      status: 503,
      body: { code: "DEMO_GUESTS_FULL", message: "Full." },
    });
    const page = await renderPage(<SignInPage />, { url: "/sign-in" });
    const card = page.getByRole("region", { name: "Just looking? Use the demo." });
    await userEvent.click(card.getByRole("button", { name: "Use the demo" }));
    await expect
      .element(card.getByRole("alert"))
      .toHaveTextContent("The demo is full right now. Try again in a little while.");
    await expect.element(page.getByLabelText("Email")).toHaveValue("");
  });

  it("offers the shared demo account, its email and password, when guests are off", async () => {
    await serveSystemInfo((info) => {
      info.features.demoGuests = false;
    });
    const page = await renderPage(<SignInPage />, { url: "/sign-in" });
    const card = page.getByRole("region", { name: "Try Director with the demo account" });
    await expect.element(card.getByText(DEMO.email)).toBeVisible();
    await expect.element(card.getByText(DEMO.password)).toBeVisible();
    await expect.element(page.getByLabelText("Email")).toHaveValue("");

    // Its email on a line of its own, whole: side by side with its label it broke mid-word.
    const email = card.getByText(DEMO.email).element().getBoundingClientRect();
    expect(email.height).toBeLessThan(30);
  });

  it("signs in to the shared demo account in one tap", async () => {
    // The account the API keeps for the demo, made here as a member would be.
    await signUp({ email: DEMO.email, password: DEMO.password, name: "Director Demo" });
    await signOut();
    await serveSystemInfo((info) => {
      info.features.demoGuests = false;
    });
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/media" });
    const card = page.getByRole("region", { name: "Try Director with the demo account" });
    await userEvent.click(card.getByRole("button", { name: "Sign in to the demo" }));
    await expect.poll(currentUrl).toBe("/media");
    expect((await currentSession()).user.email).toBe(DEMO.email);
  });

  it("fills the form with the shared demo account from ?demo=1 when guests are off", async () => {
    await serveSystemInfo((info) => {
      info.features.demoGuests = false;
    });
    const page = await renderPage(<SignInPage />, { url: "/sign-in?demo=1" });
    await expect.element(page.getByLabelText("Email")).toHaveValue(DEMO.email);
    await expect.element(page.getByLabelText("Password")).toHaveValue(DEMO.password);
  });

  it("offers no demo while system.info can't be read", async () => {
    await commands.failRequests("/rpc/system/info", { status: 503 });
    const page = await renderPage(<SignInPage />, { url: "/sign-in" });
    await expect
      .element(page.getByRole("button", { name: "Sign in with a passkey" }))
      .toBeVisible();
    // The card's room goes once the API has given up answering (after its retries).
    await expect
      .element(page.getByTestId("demo-room"), { timeout: 15_000 })
      .not.toBeInTheDocument();
    expect(page.getByText("Just looking? Use the demo.").elements()).toHaveLength(0);
    expect(page.getByText("Try Director with the demo account").elements()).toHaveLength(0);
  });

  it("keeps the demo card's room while it loads, so the form under it doesn't jump", async () => {
    const emailTop = () => page.getByLabelText("Email").element().getBoundingClientRect().top;
    let page = await renderPage(<SignInPage />, { url: "/sign-in" });
    await expect.element(page.getByRole("button", { name: "Use the demo" })).toBeVisible();
    const settled = emailTop();
    cleanup();
    // The same page while system.info hasn't answered yet (the API retries a 503).
    await commands.failRequests("/rpc/system/info", { status: 503 });
    page = await renderPage(<SignInPage />, { url: "/sign-in" });
    await expect.element(page.getByTestId("demo-room")).toBeInTheDocument();
    expect(Math.abs(emailTop() - settled)).toBeLessThanOrEqual(1);
  });

  it("says it's getting the demo account while ?demo=1 waits for it", async () => {
    await commands.failRequests("/rpc/system/info", { status: 503 });
    const page = await renderPage(<SignInPage />, { url: "/sign-in?demo=1" });
    await expect
      .element(page.getByRole("status", { name: "Getting the demo account…" }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Email")).toHaveValue("");
  });

  it("links to the other auth steps, keeping the query", async () => {
    const page = await renderPage(<SignInPage />, { url: "/sign-in?next=/settings" });
    await expect
      .element(page.getByRole("link", { name: "Create account" }))
      .toHaveAttribute("href", "/sign-up?next=%2Fsettings");
    // Each is a thumb's height (44 px) to tap, though drawn as text.
    for (const name of ["Create account", "Forgot password?"]) {
      const box = page.getByRole("link", { name }).element().getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await userEvent.click(page.getByRole("link", { name: "Forgot password?" }));
    await expect.poll(currentUrl).toBe("/forgot-password");
  });
});
