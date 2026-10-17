import { fileContentPath } from "@repo/contracts/files";
import { required } from "@repo/contracts/objects";
import type { Procedures } from "../../rpc/procedures";
import type { AvatarService } from "./avatar.service";

interface UserRow {
  id: string;
  name: string;
  email: string;
  image?: string | null | undefined;
  locale?: string | null | undefined;
  timezone?: string | null | undefined;
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
});

export const userRouter = ({ authed }: Procedures, avatar: AvatarService) => ({
  me: authed.user.me.handler(({ context: { user, session } }) =>
    toMe(user, session.activeOrganizationId),
  ),
  setAvatar: authed.user.setAvatar.handler(async ({ context: { user, session }, input }) => {
    await avatar.set(user.id, input.fileId);
    return toMe(
      { ...user, image: input.fileId ? fileContentPath(input.fileId) : null },
      session.activeOrganizationId,
    );
  }),
});
