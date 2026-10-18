import { Module } from "@nestjs/common";
import { DirectorModule } from "../director";
import { FilesModule } from "../files";
import { AssetsService } from "./assets.service";

@Module({
  imports: [DirectorModule, FilesModule],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
