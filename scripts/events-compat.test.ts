import { describe, expect, it } from "bun:test";
import { breakingChanges, check, main, report } from "./events-compat";

const uuid = { type: "string", format: "uuid" };
const todo = {
  type: "object",
  properties: { todoId: uuid, title: { type: "string" } },
  required: ["todoId", "title"],
};

describe("event compatibility", () => {
  it("allows a new event and a new optional field", () => {
    const head = {
      "todo.created.v1": { ...todo, properties: { ...todo.properties, dueAt: { type: "string" } } },
      "todo.archived.v1": todo,
    };
    expect(breakingChanges({ "todo.created.v1": todo }, head)).toEqual([]);
  });

  it.each([
    ["a field removed", { ...todo, properties: { todoId: uuid }, required: ["todoId"] }],
    ["a field retyped", { ...todo, properties: { ...todo.properties, title: { type: "number" } } }],
    [
      "a new required field",
      {
        properties: { ...todo.properties, dueAt: { type: "string" } },
        required: [...todo.required, "dueAt"],
      },
    ],
    ["a field made optional", { ...todo, required: ["todoId"] }],
    ["an enum narrowed", { ...todo, properties: { ...todo.properties, title: { enum: ["a"] } } }],
  ])("refuses %s", (_change, after) => {
    expect(breakingChanges({ "todo.created.v1": todo }, { "todo.created.v1": after })).toEqual([
      "todo.created.v1 changed other than by adding optional fields: publish a new version instead",
    ]);
  });

  it("refuses an event removed, and a schema that lost its fields altogether", () => {
    expect(
      breakingChanges(
        { "todo.created.v1": todo, "todo.deleted.v1": todo },
        {
          "todo.created.v1": { type: "object" },
        },
      ),
    ).toEqual([
      "todo.created.v1 changed other than by adding optional fields: publish a new version instead",
      "todo.deleted.v1 was removed",
    ]);
  });

  it("compares the committed catalog with the base branch's, from git", () => {
    const catalog = JSON.stringify({ "todo.created.v1": todo });
    const seen: string[] = [];
    const show = (ref: string, path: string) => {
      seen.push(`${ref}:${path}`);
      return catalog;
    };
    const renamed = JSON.stringify({ "todo.made.v1": todo });
    expect(check("origin/master", show, () => renamed)).toEqual({
      problems: ["todo.created.v1 was removed"],
    });
    expect(seen).toEqual(["origin/master:packages/jobs/generated/events.json"]);
  });

  it("passes when the base branch predates the catalog", () => {
    expect(check("origin/master", () => "").note).toBe("The base branch has no event catalog yet.");
  });

  it("reads the base from git and the head from the working tree by default", () => {
    // The catalog as committed at HEAD against the one on disk: the same, or newer by
    // this change, which must be compatible too.
    expect(check("HEAD").problems).toEqual([]);
    expect(check("HEAD", () => "{}")).toEqual({ problems: [] });
  });

  it("reports each problem as an annotation on the catalog, and fails", () => {
    const lines: string[] = [];
    const out = {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    };
    expect(report({ problems: ["todo.created.v1 was removed"] }, out)).toBe(1);
    expect(report({ problems: [], note: "The base branch has no event catalog yet." }, out)).toBe(
      0,
    );
    expect(lines).toEqual([
      "::error file=packages/jobs/generated/events.json::todo.created.v1 was removed",
      "The base branch has no event catalog yet.",
    ]);
  });
});

describe("the events compatibility command", () => {
  it("checks the working tree against the ref it's given", () => {
    // HEAD's catalog against the one on disk: compatible, or this change already fails.
    expect(main(["HEAD"])).toBe(0);
  });
});
