import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn } from "../../../test/stand-in";
import { useSetAvatarMutation } from "./avatar";
import { useMeQuery } from "./me";
import { useRemovePhoneMutation } from "./remove-phone";
import { useSendPhoneCodeMutation } from "./send-phone-code";
import { useVerifyPhoneMutation } from "./verify-phone";

const me = {
  id: id(1),
  name: "Ada",
  email: "ada@example.com",
  image: null as string | null,
  locale: "en",
  timezone: "UTC",
  activeOrganizationId: null,
  phoneNumber: null as string | null,
};

/** One account, held in memory; the code texted is always 123456. */
function accountApi() {
  const account = { ...me };
  return standIn((os) => ({
    user: {
      me: os.user.me.handler(() => account),
      sendPhoneCode: os.user.sendPhoneCode.handler(() => ({ expiresInSeconds: 600 })),
      verifyPhone: os.user.verifyPhone.handler(({ input }) => {
        if (input.code !== "123456") {
          throw new ORPCError("PHONE_CODE_INVALID");
        }
        account.phoneNumber = input.phoneNumber;
        return account;
      }),
      removePhone: os.user.removePhone.handler(() => {
        account.phoneNumber = null;
        return account;
      }),
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

  it("adds and removes a phone number, updating the user without a refetch", async () => {
    const api = accountApi();
    const { result } = renderHook(
      () => ({
        me: useMeQuery(),
        send: useSendPhoneCodeMutation(),
        verify: useVerifyPhoneMutation(),
        remove: useRemovePhoneMutation(),
      }),
      api,
    );
    await vi.waitFor(() => expect(result.current.me.data?.phoneNumber).toBeNull());
    const phoneNumber = "+15555550100";
    await expect(result.current.send.mutateAsync({ phoneNumber })).resolves.toEqual({
      expiresInSeconds: 600,
    });
    await expect(
      result.current.verify.mutateAsync({ phoneNumber, code: "000000" }),
    ).rejects.toThrow();
    await result.current.verify.mutateAsync({ phoneNumber, code: "123456" });
    await vi.waitFor(() => expect(result.current.me.data?.phoneNumber).toBe(phoneNumber));
    await result.current.remove.mutateAsync();
    await vi.waitFor(() => expect(result.current.me.data?.phoneNumber).toBeNull());
    expect(api.calls.filter((call) => call === "user/me")).toHaveLength(1);
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
