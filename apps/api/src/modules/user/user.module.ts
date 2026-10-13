import { Module } from "@nestjs/common";
import { FilesModule } from "../files";
import { AvatarService } from "./avatar.service";
import { PhoneService } from "./phone.service";
import { UserRepository } from "./user.repository";

@Module({
  imports: [FilesModule],
  providers: [UserRepository, PhoneService, AvatarService],
  exports: [PhoneService, AvatarService],
})
export class UserModule {}
