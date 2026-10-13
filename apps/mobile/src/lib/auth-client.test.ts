import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { fakeApi } from "../../test/fake-api";
import { signInWithGoogle } from "./auth-client";

jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: jest.fn() }));

describe("Google sign-in on the web build", () => {
  it("leaves Google's redirect to the browser: no hand-off, no browser sheet", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    const calls = fakeApi({ "/api/auth/sign-in/social": () => ({ url: "", redirect: false }) });
    expect(await signInWithGoogle()).toEqual({ signedIn: false, error: null });
    expect(calls.map((call) => call.path)).toEqual(["/api/auth/sign-in/social"]);
    expect(calls[0]?.input).toMatchObject({ provider: "google" });
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  });
});
