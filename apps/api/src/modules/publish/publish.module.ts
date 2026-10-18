import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics";
import { DirectorModule } from "../director";
import { FilesModule } from "../files";
import { ShortsModule } from "../shorts";
import { DailyAllowance } from "./daily-allowance";
import { PublishRepository } from "./publish.repository";
import { PublishService } from "./publish.service";

@Module({
  imports: [DirectorModule, FilesModule, ShortsModule, AnalyticsModule],
  providers: [PublishRepository, DailyAllowance, PublishService],
})
export class PublishModule {}
