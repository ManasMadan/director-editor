import { describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn } from "../../../test/stand-in";
import { useSetAvatarMutation } from "./avatar";
import { useMeQuery } from "./me";

const me = {
  id: id(1),
  name: "Ada",
  email: "ada@example.com",
  image: null as string | null,
  locale: "en",
  timezone: "UTC",
  activeOrganizationId: null,
};

/** One account, held in memory. */
function accountApi() {
  const account = { ...me };
  return standIn((os) => ({
    user: {
      me: os.user.me.handler(() => account),
      setAvatar: os.user.setAvatar.handler(({ input }) => {
        account.image = input.fileId && `https://files.test/${input.fileId}.webp`;
        return account;
      }),
    },
  }));
}

describe("the signed-in user", () => {
  it("is loaded unless turned off", async () => {
    const api = accountApi();
    const off = renderHook(() => useMeQuery({ enabled: false }), api);
    expect(off.result.current.fetchStatus).toBe("idle");
    const { result } = renderHook(() => useMeQuery(), api);
    await vi.waitFor(() => expect(result.current.data).toEqual(me));
    expect(api.calls).toEqual(["user/me"]);
  });

  it("sets and removes the profile picture", async () => {
    const api = accountApi();
    const { result } = renderHook(
      () => ({ me: useMeQuery(), setAvatar: useSetAvatarMutation() }),
      api,
    );
    await vi.waitFor(() => expect(result.current.me.data?.image).toBeNull());
    await result.current.setAvatar.mutateAsync({ fileId: id(7) });
    await vi.waitFor(() =>
      expect(result.current.me.data?.image).toBe(`https://files.test/${id(7)}.webp`),
    );
    await result.current.setAvatar.mutateAsync({ fileId: null });
    await vi.waitFor(() => expect(result.current.me.data?.image).toBeNull());
  });
});
