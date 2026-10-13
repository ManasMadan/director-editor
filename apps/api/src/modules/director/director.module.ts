import { Module } from "@nestjs/common";
import { FilesModule } from "../files";
import { ShortsModule } from "../shorts";
import { DirectorService } from "./director.service";

@Module({ imports: [ShortsModule, FilesModule], providers: [DirectorService] })
export class DirectorModule {}
