import { fireEvent, screen, waitFor } from "@testing-library/react-native";
// Tests live outside src/app: every file there is a route.
import { aSession, fail, fakeApi, openApp, server } from "../../test/app";

let ids = 0;
const todo = (title: string, completed = false) => ({
  id: `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  title,
  completed,
  version: 1,
  createdAt: "2026-09-30T12:00:00.000Z",
});
const milk = todo("Buy milk");
const bread = todo("Bake bread, done", true);

function signedIn(handlers: Parameters<typeof fakeApi>[0] = {}) {
  const calls = fakeApi({
    "/rpc/todo/list": () => ({ items: [milk, bread], nextCursor: null }),
    ...handlers,
  });
  server.session = aSession();
  return calls;
}
const callsTo = (calls: ReturnType<typeof fakeApi>, path: string) =>
  calls.filter((call) => call.path === path);

describe("the todo list", () => {
  it("shows the workspace's todos, done ones struck through", async () => {
    signedIn();
    await openApp("/");
    expect(await screen.findByRole("checkbox", { name: "Buy milk" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Bake bread, done" })).toBeChecked();
  });

  it("says when there is nothing to do yet", async () => {
    signedIn({ "/rpc/todo/list": () => ({ items: [], nextCursor: null }) });
    await openApp("/");
    expect(await screen.findByText("Nothing to do. Add your first todo above.")).toBeOnTheScreen();
  });

  it("adds a todo and clears the field", async () => {
    const calls = signedIn({ "/rpc/todo/create": (input) => todo(String(input.title)) });
    await openApp("/");
    await fireEvent.changeText(await screen.findByLabelText("Todos"), "Call mum");
    await fireEvent.press(screen.getByText("Add"));
    expect(await screen.findByRole("checkbox", { name: "Call mum" })).toBeOnTheScreen();
    expect(screen.getByLabelText("Todos")).toHaveDisplayValue("");
    expect(callsTo(calls, "/rpc/todo/create")[0]?.input).toEqual({ title: "Call mum" });
  });

  it("won't add an empty todo", async () => {
    const calls = signedIn();
    await openApp("/");
    await fireEvent(await screen.findByLabelText("Todos"), "submitEditing");
    expect(await screen.findByRole("alert")).toBeOnTheScreen();
    expect(callsTo(calls, "/rpc/todo/create")).toHaveLength(0);
  });

  it("says why a todo couldn't be added, in the user's words", async () => {
    signedIn({
      "/rpc/todo/create": () => fail(429, "RATE_LIMITED", { params: { retryAfterSeconds: 5 } }),
    });
    await openApp("/");
    await fireEvent.changeText(await screen.findByLabelText("Todos"), "Call mum");
    await fireEvent.press(screen.getByText("Add"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again in 5 seconds.",
    );
  });

  it("ticks a todo off", async () => {
    const calls = signedIn({
      "/rpc/todo/setCompleted": () => ({ ...milk, completed: true, version: 2 }),
    });
    await openApp("/");
    await fireEvent.press(await screen.findByRole("checkbox", { name: "Buy milk" }));
    await waitFor(() =>
      expect(callsTo(calls, "/rpc/todo/setCompleted")[0]?.input).toEqual({
        id: milk.id,
        completed: true,
        version: 1,
      }),
    );
  });

  it("puts a todo back and says why when ticking it off fails", async () => {
    signedIn({ "/rpc/todo/setCompleted": () => fail(409, "TODO_VERSION_CONFLICT") });
    await openApp("/");
    await fireEvent.press(await screen.findByRole("checkbox", { name: "Buy milk" }));
    expect(await screen.findByRole("alert")).toBeOnTheScreen();
    expect(screen.getByRole("checkbox", { name: "Buy milk" })).not.toBeChecked();
  });

  it("deletes a todo", async () => {
    let items = [milk, bread];
    const calls = signedIn({
      "/rpc/todo/list": () => ({ items, nextCursor: null }),
      "/rpc/todo/delete": (input) => {
        items = items.filter((item) => item.id !== input.id);
      },
    });
    await openApp("/");
    await fireEvent.press(await screen.findByLabelText("Delete Buy milk"));
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Buy milk" })).not.toBeOnTheScreen(),
    );
    expect(callsTo(calls, "/rpc/todo/delete")[0]?.input).toEqual({ id: milk.id });
  });

  it("keeps a todo it couldn't delete, and says why", async () => {
    signedIn({ "/rpc/todo/delete": () => fail(403, "FORBIDDEN") });
    await openApp("/");
    await fireEvent.press(await screen.findByLabelText("Delete Buy milk"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You don't have permission to do that.",
    );
    expect(screen.getByRole("checkbox", { name: "Buy milk" })).toBeOnTheScreen();
  });

  it("loads the next page at the end of the list, up to the last", async () => {
    const calls = signedIn({
      "/rpc/todo/list": (input) =>
        input.cursor
          ? { items: [bread], nextCursor: null }
          : { items: [milk], nextCursor: "page-2" },
    });
    await openApp("/");
    const first = await screen.findByRole("checkbox", { name: "Buy milk" });
    await fireEvent(first, "endReached");
    expect(await screen.findByRole("checkbox", { name: "Bake bread, done" })).toBeOnTheScreen();
    // The last page: nothing more to ask for.
    await fireEvent(first, "endReached");
    expect(callsTo(calls, "/rpc/todo/list").map((call) => call.input.cursor)).toEqual([
      undefined,
      "page-2",
    ]);
  });

  it("refreshes when pulled down", async () => {
    const calls = signedIn();
    await openApp("/");
    await screen.findByRole("checkbox", { name: "Buy milk" });
    const [refresh] = screen.container.queryAll((node) => node.type === "RCTRefreshControl");
    await fireEvent(refresh as never, "refresh");
    await waitFor(() => expect(callsTo(calls, "/rpc/todo/list")).toHaveLength(2));
  });

  it("sends an app the API no longer supports to the update screen", async () => {
    signedIn({ "/rpc/todo/list": () => fail(400, "CLIENT_OUTDATED") });
    const app = await openApp("/");
    expect(await screen.findByText("Update required")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/update-required");
  });
});
