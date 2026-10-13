import { ORPCError } from "@orpc/client";
import type { ApiKey } from "@repo/contracts/api";
import { apiKeyIdSchema } from "@repo/contracts/ids";
import { describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn } from "../../../test/stand-in";
import { useCreateApiKeyMutation } from "./create";
import { useApiKeysQuery } from "./list";
import { useRevokeApiKeyMutation } from "./revoke";

describe("API keys", () => {
  it("creates a key, shown once, and revokes it; the list follows each change", async () => {
    let keys: ApiKey[] = [];
    const api = standIn((os) => ({
      apiKeys: {
        list: os.apiKeys.list.handler(() => keys),
        create: os.apiKeys.create.handler(({ input }) => {
          const apiKey: ApiKey = {
            id: apiKeyIdSchema.parse(id(keys.length + 1)),
            name: input.name,
            start: "bp_abc",
            scopes: input.scopes,
            createdBy: null,
            createdAt: new Date(0),
            expiresAt: null,
            lastUsedAt: null,
          };
          keys = [...keys, apiKey];
          return { apiKey, key: "bp_abcdef" };
        }),
        revoke: os.apiKeys.revoke.handler(({ input }) => {
          if (!keys.some((k) => k.id === input.id)) {
            throw new ORPCError("API_KEY_NOT_FOUND");
          }
          keys = keys.filter((k) => k.id !== input.id);
        }),
      },
    }));
    const { result } = renderHook(
      () => ({
        keys: useApiKeysQuery(),
        create: useCreateApiKeyMutation(),
        revoke: useRevokeApiKeyMutation(),
      }),
      api,
    );
    const names = () => result.current.keys.data?.map((k) => k.name);
    await vi.waitFor(() => expect(names()).toEqual([]));
    const created = await result.current.create.mutateAsync({
      name: "CI",
      scopes: ["todos:read"],
      expiresInDays: 30,
    });
    expect(created.key).toBe("bp_abcdef");
    await vi.waitFor(() => expect(names()).toEqual(["CI"]));

    await result.current.revoke.mutateAsync({ id: created.apiKey.id });
    await vi.waitFor(() => expect(names()).toEqual([]));
    // A key someone else already revoked: the list is refetched anyway.
    const lists = api.calls.filter((call) => call === "apiKeys/list").length;
    await expect(result.current.revoke.mutateAsync({ id: created.apiKey.id })).rejects.toThrow();
    await vi.waitFor(() =>
      expect(api.calls.filter((call) => call === "apiKeys/list")).toHaveLength(lists + 1),
    );
  });
});
