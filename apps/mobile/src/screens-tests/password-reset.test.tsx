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

const REQUEST = "/api/auth/email-otp/request-password-reset";
const RESET = "/api/auth/email-otp/reset-password";

async function requestCode(email = "ada@example.com") {
  await fireEvent.changeText(await screen.findByLabelText("Email"), email);
  await fireEvent.press(screen.getByText("Send code"));
}

async function reset(code: string, password: string) {
  await fireEvent.changeText(await screen.findByLabelText("Verification code"), code);
  await fireEvent.changeText(screen.getByLabelText("New password"), password);
  await fireEvent.press(screen.getByText("Continue"));
}

describe("asking for a password reset code", () => {
  it("is linked from sign-in, and back", async () => {
    fakeApi();
    const app = await openApp("/sign-in");
    await fireEvent.press(await screen.findByText("Forgot password?"));
    expect(await screen.findByText("Reset your password")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/forgot-password");
    await fireEvent.press(screen.getByText("Back to sign in"));
    expect(await screen.findByText("Welcome back")).toBeOnTheScreen();
  });

  it("checks the address before asking the server", async () => {
    const calls = fakeApi();
    await openApp("/forgot-password");
    await requestCode("not an email");
    expect(await screen.findByText("Enter a valid email address")).toBeOnTheScreen();
    expect(calls.map((call) => call.path)).not.toContain(REQUEST);
  });

  it("sends the code, then asks for it with the new password", async () => {
    const calls = fakeApi({ [REQUEST]: () => ({ success: true }) });
    const app = await openApp("/forgot-password");
    await requestCode();
    expect(await screen.findByText("Choose a new password")).toBeOnTheScreen();
    expect(app.pathnameWithParams()).toBe("/reset-password?email=ada%40example.com");
    expect(calls.find((call) => call.path === REQUEST)?.input).toEqual({
      email: "ada@example.com",
    });
  });

  it("passes the security check first, when the API asks for one", async () => {
    browser.mockResolvedValue({ type: "success", url: "boilerplate://captcha-done?token=token-1" });
    const calls = fakeApi({ "/rpc/system/info": captchaOn, [REQUEST]: () => ({ success: true }) });
    await openApp("/forgot-password");
    await requestCode();
    expect(await screen.findByText("Choose a new password")).toBeOnTheScreen();
    const sent = calls.find((call) => call.path === REQUEST);
    expect(sent?.headers.get("x-captcha-response")).toBe("token-1");
  });

  it("sends nothing when the security check was closed", async () => {
    browser.mockResolvedValue({ type: WebBrowser.WebBrowserResultType.CANCEL });
    const calls = fakeApi({ "/rpc/system/info": captchaOn });
    await openApp("/forgot-password");
    await requestCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The security check wasn't finished. Try again.",
    );
    expect(calls.map((call) => call.path)).not.toContain(REQUEST);
  });

  it("says why the code couldn't be sent", async () => {
    fakeApi({ [REQUEST]: () => fail(429) });
    const app = await openApp("/forgot-password");
    await requestCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Wait a minute and try again.",
    );
    expect(app.pathname()).toBe("/forgot-password");
  });
});

describe("choosing a new password", () => {
  const url = "/reset-password?email=ada%40example.com";

  it.each(["/reset-password", "/reset-password?email=nonsense"])(
    "asks for the address again without a valid one (%s)",
    async (link) => {
      fakeApi();
      const app = await openApp(link);
      expect(await screen.findByText("Reset your password")).toBeOnTheScreen();
      expect(app.pathname()).toBe("/forgot-password");
    },
  );

  it("names the address and checks the form before asking the server", async () => {
    const calls = fakeApi();
    await openApp(url);
    expect(
      await screen.findByText("Enter the code sent to ada@example.com and your new password."),
    ).toBeOnTheScreen();
    await reset("12", "short");
    expect(await screen.findByText("Enter the 6-digit code")).toBeOnTheScreen();
    expect(screen.getByText("Use at least 8 characters")).toBeOnTheScreen();
    expect(calls.map((call) => call.path)).not.toContain(RESET);
  });

  it("clears a wrong code and says why", async () => {
    fakeApi({ [RESET]: () => fail(400, "INVALID_OTP") });
    await openApp(url);
    await reset("123456", "a new password");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That code is wrong or has expired.",
    );
    expect(screen.getByLabelText("Verification code")).toHaveDisplayValue("");
  });

  it("sets the password and sends the user to sign in with it", async () => {
    const calls = fakeApi({ [RESET]: () => ({ success: true }) });
    const app = await openApp(url);
    await reset("123456", "a new password");
    expect(await screen.findByText("Welcome back")).toBeOnTheScreen();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Password updated. Sign in with your new password.",
    );
    expect(app.pathname()).toBe("/sign-in");
    expect(calls.find((call) => call.path === RESET)?.input).toEqual({
      email: "ada@example.com",
      otp: "123456",
      password: "a new password",
    });
  });
});
