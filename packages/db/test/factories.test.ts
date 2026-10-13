/** The test-data builders write valid rows as the api's role, tenant data included. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "../src";
import { createTestDatabase, factories, type TestDatabase } from "../src/testing";

let testDb: TestDatabase;
let db: Db;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createDb({ url: testDb.urlFor("app_api"), poolMax: 2, service: "test" });
});
afterAll(async () => {
  await db.$disconnect();
  await testDb.drop();
});

describe("factories", () => {
  it("make a verified user with a personal workspace they own", async () => {
    const { user, org } = await factories(db).userWithWorkspace({ name: "Ada" });
    expect(user).toMatchObject({ name: "Ada", emailVerified: true });
    expect(org.slug).toBe(`personal-${user.id}`);
    expect(JSON.parse(org.metadata ?? "{}")).toEqual({ personal: true });
    expect(await db.member.findMany({ where: { organizationId: org.id } })).toEqual([
      expect.objectContaining({ userId: user.id, role: "owner" }),
    ]);
  });

  it("add members and tenant rows, which row-level security keeps to their workspace", async () => {
    const make = factories(db);
    const { user, org } = await make.userWithWorkspace();
    const other = await make.userWithWorkspace();
    await make.member(org.id, other.user.id, "admin");
    await make.todo(org.id, user.id, { title: "Ours", completed: true });
    await make.todo(other.org.id, other.user.id, { title: "Theirs" });
    const visible = await withTenant(db, org.id).todo.findMany({ select: { title: true } });
    expect(visible).toEqual([{ title: "Ours" }]);
  });

  it("make a shared workspace and a todo with defaults when nothing is overridden", async () => {
    const make = factories(db);
    const owner = await make.user();
    const org = await make.organization(owner.id);
    expect(org).toMatchObject({ name: expect.stringMatching(/^Org /), metadata: null });
    expect(org.slug).toMatch(/^org-/);
    const todo = await make.todo(org.id, owner.id);
    expect(todo).toMatchObject({ title: expect.stringMatching(/^Todo /), completed: false });
  });

  it("never collide between calls", async () => {
    const make = factories(db);
    const [a, b] = await Promise.all([make.user(), make.user()]);
    expect(a.email).not.toBe(b.email);
  });
});
