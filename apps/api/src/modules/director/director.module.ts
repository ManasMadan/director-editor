import { Module } from "@nestjs/common";
import { FilesModule } from "../files";
import { RecordingModule } from "../recording";
import { ShortsModule } from "../shorts";
import { DirectorService } from "./director.service";

@Module({
  imports: [ShortsModule, FilesModule, RecordingModule],
  providers: [DirectorService],
  exports: [DirectorService],
})
export class DirectorModule {}
