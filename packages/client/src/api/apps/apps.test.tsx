import type { ConnectedApp } from "@repo/contracts/api";
import { orgIdSchema } from "@repo/contracts/ids";
import { describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn } from "../../../test/stand-in";
import { useDisconnectAppMutation } from "./disconnect";
import { useConnectedAppsQuery } from "./list";

const app = (n: number): ConnectedApp => ({
  id: id(n),
  clientId: `client-${n}`,
  name: `App ${n}`,
  uri: null,
  workspace: { id: orgIdSchema.parse(id(50)), name: "Acme" },
  scopes: ["todos:read"],
  connectedAt: new Date(0),
  lastUsedAt: null,
});

describe("connected apps", () => {
  it("lists them, and refetches after one is disconnected", async () => {
    let apps = [app(1), app(2)];
    const api = standIn((os) => ({
      apps: {
        list: os.apps.list.handler(() => apps),
        disconnect: os.apps.disconnect.handler(({ input }) => {
          apps = apps.filter((a) => a.id !== input.id);
        }),
      },
    }));
    const { result } = renderHook(
      () => ({
        apps: useConnectedAppsQuery(),
        disconnect: useDisconnectAppMutation(),
      }),
      api,
    );
    const names = () => result.current.apps.data?.map((a) => a.name);
    await vi.waitFor(() => expect(names()).toEqual(["App 1", "App 2"]));
    await result.current.disconnect.mutateAsync({ id: id(1) });
    await vi.waitFor(() => expect(names()).toEqual(["App 2"]));
  });
});
