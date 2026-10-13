import { fireEvent, screen } from "@testing-library/react-native";
// Tests live outside src/app: every file there is a route.
import { aSession, fail, fakeApi, openApp, server } from "../../test/app";

const signedIn = () => {
  server.session = aSession();
  return { token: "token-1", user: server.session.user };
};

async function enter(label: string, code: string) {
  await fireEvent.changeText(await screen.findByLabelText(label), code);
  await fireEvent.press(screen.getByText("Continue"));
}

describe("the second sign-in step", () => {
  it("signs in with the authenticator's code", async () => {
    const calls = fakeApi({ "/api/auth/two-factor/verify-totp": signedIn });
    const app = await openApp("/two-factor");
    await enter("Verification code", "123456");
    expect(await screen.findByText("Nothing to do. Add your first todo above.")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/");
    expect(calls.find((call) => call.path === "/api/auth/two-factor/verify-totp")?.input).toEqual({
      code: "123456",
    });
  });

  it("clears a wrong code and says why", async () => {
    fakeApi({ "/api/auth/two-factor/verify-totp": () => fail(401, "INVALID_CODE") });
    await openApp("/two-factor");
    await enter("Verification code", "123456");
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is wrong.");
    expect(screen.getByLabelText("Verification code")).toHaveDisplayValue("");
  });

  it("takes a backup code instead", async () => {
    const calls = fakeApi({ "/api/auth/two-factor/verify-backup-code": signedIn });
    await openApp("/two-factor");
    await fireEvent.press(await screen.findByText("Use a backup code instead"));
    await enter("Backup code", "");
    expect(await screen.findByText("Required")).toBeOnTheScreen();
    await enter("Backup code", "abcde-12345");
    expect(await screen.findByText("Nothing to do. Add your first todo above.")).toBeOnTheScreen();
    expect(
      calls.find((call) => call.path === "/api/auth/two-factor/verify-backup-code")?.input,
    ).toEqual({ code: "abcde-12345" });
  });

  it("can switch back to the authenticator", async () => {
    fakeApi();
    await openApp("/two-factor");
    await fireEvent.press(await screen.findByText("Use a backup code instead"));
    await fireEvent.press(await screen.findByText("Use your authenticator app"));
    expect(await screen.findByLabelText("Verification code")).toBeOnTheScreen();
  });
});
