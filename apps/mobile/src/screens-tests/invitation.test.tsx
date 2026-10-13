import { fireEvent, screen, waitFor } from "@testing-library/react-native";
// Tests live outside src/app: every file there is a route.
import { aSession, fail, fakeApi, openApp, server } from "../../test/app";

const link = "/invitations/inv-1";

function invited(handlers: Parameters<typeof fakeApi>[0] = {}) {
  const calls = fakeApi({
    "/api/auth/organization/get-invitation": () => ({ id: "inv-1", organizationName: "Acme" }),
    "/api/auth/organization/set-active": () => ({ id: "org-2" }),
    ...handlers,
  });
  server.session = aSession();
  return calls;
}
const callsTo = (calls: ReturnType<typeof fakeApi>, path: string) =>
  calls.filter((call) => call.path === path);

describe("an invitation link", () => {
  it("shows the invitation and joins nothing until Accept is tapped", async () => {
    const calls = invited({
      "/api/auth/organization/accept-invitation": () => ({
        invitation: { id: "inv-1", organizationId: "org-2" },
        member: { id: "member-1" },
      }),
    });
    const app = await openApp(link);
    expect(await screen.findByText("Join Acme to start collaborating.")).toBeOnTheScreen();
    expect(callsTo(calls, "/api/auth/organization/get-invitation")[0]?.input).toEqual({
      id: "inv-1",
    });
    expect(callsTo(calls, "/api/auth/organization/accept-invitation")).toHaveLength(0);

    await fireEvent.press(screen.getByText("Accept invitation"));
    await waitFor(() => expect(app.pathname()).toBe("/"));
    expect(callsTo(calls, "/api/auth/organization/accept-invitation")[0]?.input).toEqual({
      invitationId: "inv-1",
    });
    expect(callsTo(calls, "/api/auth/organization/set-active")[0]?.input).toEqual({
      organizationId: "org-2",
    });
  });

  it("opens from the site's https link too (a universal link or App Link)", async () => {
    invited();
    const app = await openApp("https://app.example.com/invitations/inv-1");
    expect(await screen.findByText("Join Acme to start collaborating.")).toBeOnTheScreen();
    expect(app.pathname()).toBe(link);
  });

  it("can be declined", async () => {
    const calls = invited({ "/api/auth/organization/reject-invitation": () => ({}) });
    const app = await openApp(link);
    await fireEvent.press(await screen.findByText("Decline"));
    await waitFor(() => expect(app.pathname()).toBe("/"));
    expect(callsTo(calls, "/api/auth/organization/reject-invitation")[0]?.input).toEqual({
      invitationId: "inv-1",
    });
    expect(callsTo(calls, "/api/auth/organization/accept-invitation")).toHaveLength(0);
  });

  it("says why it couldn't be accepted", async () => {
    const calls = invited({
      "/api/auth/organization/accept-invitation": () =>
        fail(403, "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED"),
    });
    await openApp(link);
    await fireEvent.press(await screen.findByText("Accept invitation"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your plan's member limit is reached. Upgrade in billing settings to invite more people.",
    );
    expect(callsTo(calls, "/api/auth/organization/set-active")).toHaveLength(0);
  });

  it("says why it couldn't be declined", async () => {
    invited({ "/api/auth/organization/reject-invitation": () => fail(500) });
    const app = await openApp(link);
    await fireEvent.press(await screen.findByText("Decline"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Please try again.",
    );
    expect(app.pathname()).toBe(link);
  });

  it("says when the invitation is gone, with nothing to accept", async () => {
    invited({ "/api/auth/organization/get-invitation": () => fail(400, "INVITATION_NOT_FOUND") });
    await openApp(link);
    expect(await screen.findByText("This invitation is invalid or has expired.")).toBeOnTheScreen();
    expect(screen.queryByText("Accept invitation")).not.toBeOnTheScreen();
  });

  it("asks a signed-out user to sign in first", async () => {
    const calls = fakeApi();
    const app = await openApp(link);
    expect(await screen.findByText("Welcome back")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/sign-in");
    expect(callsTo(calls, "/api/auth/organization/get-invitation")).toHaveLength(0);
  });
});
