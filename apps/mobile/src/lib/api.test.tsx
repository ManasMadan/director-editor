import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { useMeQuery } from "@repo/client/api/user/me";
import { render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { Platform, Text } from "react-native";
import { fail, fakeApi } from "../../test/fake-api";
import { ApiProvider } from "./api";
import { authClient } from "./auth-client";
import { appVersion } from "./config";

// No navigator here: only where the app is sent.
jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn() } }));

function Me() {
  const me = useMeQuery();
  const system = useSystemInfoQuery();
  return <Text>{`${me.status} ${system.status}`}</Text>;
}

const open = (locale = "en") =>
  render(
    <ApiProvider locale={locale}>
      <Me />
    </ApiProvider>,
  );
const callsTo = (calls: ReturnType<typeof fakeApi>, path: string) =>
  calls.filter((call) => call.path === path);

afterEach(() => jest.clearAllMocks());

describe("the app's API client", () => {
  it("sends the session cookie from secure storage, the app version and the language", async () => {
    const calls = fakeApi({
      "/api/auth/sign-in/email": () =>
        new Response(JSON.stringify({ token: "abc" }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": "better-auth.session_token=abc; Path=/; HttpOnly; SameSite=Lax",
          },
        }),
      "/rpc/user/me": () => ({ id: "user-1" }),
    });
    await authClient.signIn.email({ email: "ada@example.com", password: "correct horse" });
    await open("es");
    await waitFor(() => expect(callsTo(calls, "/rpc/user/me")).toHaveLength(1));
    const headers = callsTo(calls, "/rpc/user/me")[0]?.headers ?? new Headers();
    expect(headers.get("cookie")).toBe("better-auth.session_token=abc");
    expect(headers.get("x-app-version")).toBe(appVersion);
    expect(headers.get("x-locale")).toBe("es");
  });

  it("sends no cookie once signed out", async () => {
    const calls = fakeApi({
      "/api/auth/sign-out": () => ({ success: true }),
      "/rpc/user/me": () => ({ id: "user-1" }),
    });
    await authClient.signOut();
    await open();
    await waitFor(() => expect(callsTo(calls, "/rpc/user/me")).toHaveLength(1));
    expect(callsTo(calls, "/rpc/user/me")[0]?.headers.has("cookie")).toBe(false);
  });

  it("leaves the cookie to the browser on the web", async () => {
    const web = jest.replaceProperty(Platform, "OS", "web");
    Object.defineProperty(window, "location", {
      value: { origin: "http://localhost:3000" },
      configurable: true,
    });
    const calls = fakeApi({ "/rpc/user/me": () => ({ id: "user-1" }) });
    try {
      await open();
      await waitFor(() => expect(callsTo(calls, "/rpc/user/me")).toHaveLength(1));
    } finally {
      Reflect.deleteProperty(window, "location");
      web.restore();
    }
    expect(callsTo(calls, "/rpc/user/me")[0]?.headers.has("cookie")).toBe(false);
  });

  it("shows the update screen when the API no longer supports this build", async () => {
    fakeApi({ "/rpc/user/me": () => fail(400, "CLIENT_OUTDATED") });
    await open();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/update-required"));
  });

  it("signs out and goes to sign-in when the session is gone", async () => {
    const calls = fakeApi({
      "/rpc/user/me": () => fail(401, "UNAUTHENTICATED"),
      "/api/auth/sign-out": () => ({ success: true }),
    });
    await open();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"));
    expect(callsTo(calls, "/api/auth/sign-out").length).toBeGreaterThan(0);
  });
});

describe("losing the active workspace", () => {
  const noWorkspace = () => fail(403, "NO_ACTIVE_ORGANIZATION");

  it("switches to the user's next workspace, once however many calls fail", async () => {
    const calls = fakeApi({
      "/rpc/user/me": noWorkspace,
      "/rpc/system/info": noWorkspace,
      "/api/auth/organization/list": () => [{ id: "org-2", name: "Globex" }],
      "/api/auth/organization/set-active": () => ({ id: "org-2" }),
    });
    await open();
    await waitFor(() =>
      expect(callsTo(calls, "/api/auth/organization/set-active")[0]?.input).toEqual({
        organizationId: "org-2",
      }),
    );
    expect(callsTo(calls, "/api/auth/organization/list")).toHaveLength(1);
  });

  it("stays put when the user has no other workspace", async () => {
    const calls = fakeApi({
      "/rpc/user/me": noWorkspace,
      "/api/auth/organization/list": () => [],
    });
    await open();
    await waitFor(() => expect(callsTo(calls, "/api/auth/organization/list")).toHaveLength(1));
    expect(callsTo(calls, "/api/auth/organization/set-active")).toHaveLength(0);
  });
});
