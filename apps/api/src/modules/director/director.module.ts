import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics";
import { FilesModule } from "../files";
import { ShortsModule } from "../shorts";
import { DirectorService } from "./director.service";

@Module({
  imports: [ShortsModule, FilesModule, AnalyticsModule],
  providers: [DirectorService],
})
export class DirectorModule {}
