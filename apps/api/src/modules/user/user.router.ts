import { fileContentPath } from "@repo/contracts/files";
import { required } from "@repo/contracts/objects";
import type { Procedures } from "../../rpc/procedures";
import type { AvatarService } from "./avatar.service";
import type { PhoneService } from "./phone.service";

interface UserRow {
  id: string;
  name: string;
  email: string;
  image?: string | null | undefined;
  locale?: string | null | undefined;
  timezone?: string | null | undefined;
  phoneNumber?: string | null | undefined;
}

const toMe = (user: UserRow, activeOrganizationId: string | null | undefined) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  image: user.image ?? null,
  // NOT NULL columns; better-auth types its optional fields as nullable.
  locale: required(user.locale, "the locale"),
  timezone: required(user.timezone, "the time zone"),
  activeOrganizationId: activeOrganizationId ?? null,
  phoneNumber: user.phoneNumber ?? null,
});

export const userRouter = (
  { authed, fresh }: Procedures,
  phone: PhoneService,
  avatar: AvatarService,
) => ({
  me: authed.user.me.handler(async ({ context: { user, session } }) =>
    // The phone number isn't part of better-auth's session user.
    toMe({ ...user, phoneNumber: await phone.current(user.id) }, session.activeOrganizationId),
  ),
  setAvatar: authed.user.setAvatar.handler(async ({ context: { user, session }, input }) => {
    await avatar.set(user.id, input.fileId);
    return toMe(
      {
        ...user,
        image: input.fileId ? fileContentPath(input.fileId) : null,
        phoneNumber: await phone.current(user.id),
      },
      session.activeOrganizationId,
    );
  }),
  sendPhoneCode: fresh.user.sendPhoneCode.handler(({ context, input }) =>
    phone.sendCode(context.user.id, context.user.locale, input.phoneNumber),
  ),
  verifyPhone: fresh.user.verifyPhone.handler(async ({ context, input }) =>
    toMe(
      await phone.verify(context.user.id, input.phoneNumber, input.code),
      context.session.activeOrganizationId,
    ),
  ),
  removePhone: fresh.user.removePhone.handler(async ({ context }) =>
    toMe(await phone.remove(context.user.id), context.session.activeOrganizationId),
  ),
});
