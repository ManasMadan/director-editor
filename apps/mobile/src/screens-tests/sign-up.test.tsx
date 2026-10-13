import { fireEvent, screen } from "@testing-library/react-native";
import * as WebBrowser from "expo-web-browser";
// Tests live outside src/app: every file there is a route.
import { fail, fakeApi, openApp } from "../../test/app";

// The security check opens in the system's browser sheet, which tests don't have: each
// test says how the person left it.
jest.mock("expo-web-browser", () => ({
  ...jest.requireActual("expo-web-browser"),
  openAuthSessionAsync: jest.fn(),
}));
const browser = jest.mocked(WebBrowser.openAuthSessionAsync);
const captchaOn = () => ({
  features: { captcha: true },
  captchaSiteKey: "site-key",
  minimumClientVersion: "0.0.0",
});

async function signUp(name: string, email: string, password: string) {
  await fireEvent.changeText(await screen.findByLabelText("Full name"), name);
  await fireEvent.changeText(screen.getByLabelText("Email"), email);
  await fireEvent.changeText(screen.getByLabelText("Password"), password);
  await fireEvent.press(screen.getByText("Create account"));
}

describe("creating an account", () => {
  it("checks the form before asking the server", async () => {
    const calls = fakeApi();
    await openApp("/sign-up");
    await signUp("", "ada@example.com", "short");
    expect(await screen.findByText("Enter your name")).toBeOnTheScreen();
    expect(screen.getByText("Use at least 8 characters")).toBeOnTheScreen();
    expect(calls.map((call) => call.path)).not.toContain("/api/auth/sign-up/email");
  });

  it("sends the device's language and time zone, then asks for the emailed code", async () => {
    const calls = fakeApi({ "/api/auth/sign-up/email": () => ({ token: null }) });
    const app = await openApp("/sign-up");
    await signUp("Ada", "ada@example.com", "correct horse");
    expect(await screen.findByText("Check your email")).toBeOnTheScreen();
    expect(app.pathnameWithParams()).toBe("/verify-email?email=ada%40example.com");
    expect(calls.find((call) => call.path === "/api/auth/sign-up/email")?.input).toEqual({
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse",
      locale: "en",
      timezone: expect.any(String),
    });
    // Captcha is off: no security check, no token.
    expect(browser).not.toHaveBeenCalled();
    expect(
      calls
        .find((call) => call.path === "/api/auth/sign-up/email")
        ?.headers.has("x-captcha-response"),
    ).toBe(false);
  });

  it("passes the security check first when the API asks for one", async () => {
    browser.mockResolvedValue({ type: "success", url: "yourscheme://captcha-done?token=token-1" });
    const calls = fakeApi({
      "/rpc/system/info": captchaOn,
      "/api/auth/sign-up/email": () => ({ token: null }),
    });
    await openApp("/sign-up");
    await signUp("Ada", "ada@example.com", "correct horse");
    expect(await screen.findByText("Check your email")).toBeOnTheScreen();
    // The site's captcha page, coming back into the app (expo-router's test renderer
    // names the app's scheme "yourscheme").
    expect(browser).toHaveBeenCalledWith(
      "http://localhost:3000/captcha?return_to=yourscheme%3A%2F%2Fcaptcha-done",
      "yourscheme://captcha-done",
    );
    const signUpCall = calls.find((call) => call.path === "/api/auth/sign-up/email");
    expect(signUpCall?.headers.get("x-captcha-response")).toBe("token-1");
  });

  it.each<[string, WebBrowser.WebBrowserAuthSessionResult]>([
    ["closed", { type: WebBrowser.WebBrowserResultType.CANCEL }],
    ["came back without a token", { type: "success", url: "yourscheme://captcha-done" }],
  ])("doesn't sign up when the security check was %s", async (_, result) => {
    browser.mockResolvedValue(result);
    const calls = fakeApi({ "/rpc/system/info": captchaOn });
    await openApp("/sign-up");
    await signUp("Ada", "ada@example.com", "correct horse");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The security check wasn't finished. Try again.",
    );
    expect(calls.map((call) => call.path)).not.toContain("/api/auth/sign-up/email");
  });

  it("says when the email already has an account", async () => {
    fakeApi({
      "/api/auth/sign-up/email": () => fail(422, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"),
    });
    await openApp("/sign-up");
    await signUp("Ada", "ada@example.com", "correct horse");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An account with this email already exists.",
    );
  });

  it("links back to signing in", async () => {
    fakeApi();
    const app = await openApp("/sign-up");
    await fireEvent.press(await screen.findByText("Sign in"));
    expect(await screen.findByText("Welcome back")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/sign-in");
  });
});
