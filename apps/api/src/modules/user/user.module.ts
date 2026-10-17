import { Module } from "@nestjs/common";
import { FilesModule } from "../files";
import { AvatarService } from "./avatar.service";
import { UserRepository } from "./user.repository";

@Module({
  imports: [FilesModule],
  providers: [UserRepository, AvatarService],
  exports: [AvatarService],
})
export class UserModule {}
