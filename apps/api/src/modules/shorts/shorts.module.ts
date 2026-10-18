import { Module } from "@nestjs/common";
import { ShortsService } from "./shorts.service";

@Module({ providers: [ShortsService], exports: [ShortsService] })
export class ShortsModule {}
