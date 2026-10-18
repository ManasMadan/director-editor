import { Module } from "@nestjs/common";
import { YourVersionRepository } from "./your-version.repository";
import { YourVersionService } from "./your-version.service";

@Module({
  providers: [YourVersionRepository, YourVersionService],
  exports: [YourVersionService],
})
export class YourVersionModule {}
