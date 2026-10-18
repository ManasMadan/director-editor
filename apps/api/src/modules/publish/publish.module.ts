import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics";
import { AssetsModule } from "../assets";
import { DirectorModule } from "../director";
import { FilesModule } from "../files";
import { ShortsModule } from "../shorts";
import { DailyAllowance } from "./daily-allowance";
import { PublishRepository } from "./publish.repository";
import { PublishService } from "./publish.service";

@Module({
  imports: [DirectorModule, FilesModule, ShortsModule, AnalyticsModule, AssetsModule],
  providers: [PublishRepository, DailyAllowance, PublishService],
})
export class PublishModule {}
