/**
 * The profile picture is an avatar upload that apps/worker has checked and re-encoded.
 * `user.image` holds its content path, and the previous picture is deleted when it's
 * replaced (the database queues its stored objects for removal).
 *
 * It's written through better-auth's internal adapter so every cached session sees the
 * new picture at once. Clients can't set `image` themselves (see the user update hook
 * in auth-hooks.ts), so it only ever points at a checked file.
 */
import { Injectable } from "@nestjs/common";
import { fileContentPath } from "@repo/contracts/files";
import { type FileId, fileIdSchema, type UserId } from "@repo/contracts/ids";
import { type Auth, InjectAuth } from "../../auth/auth.module";
import { FilesService } from "../files";
import { UserRepository } from "./user.repository";

const AVATAR_PATH = /^\/api\/v1\/files\/([0-9a-f-]{36})\/content$/;

@Injectable()
export class AvatarService {
  constructor(
    @InjectAuth() private readonly auth: Auth,
    private readonly users: UserRepository,
    private readonly files: FilesService,
  ) {}

  async set(userId: UserId, fileId: FileId | null) {
    if (fileId) {
      await this.files.ready(userId, fileId, "avatar");
    }
    const current = await this.users.image(userId);
    const previous = fileIdSchema.safeParse(AVATAR_PATH.exec(current.image ?? "")?.[1]).data;
    const context = await this.auth.$context;
    await context.internalAdapter.updateUser(userId, {
      image: fileId ? fileContentPath(fileId) : null,
    });
    if (previous && previous !== fileId) {
      await this.files.remove(userId, previous);
    }
  }
}
