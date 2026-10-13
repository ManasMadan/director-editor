import { Module } from "@nestjs/common";
import { ShortsRepository } from "./shorts.repository";
import { ShortsService } from "./shorts.service";

@Module({ providers: [ShortsRepository, ShortsService], exports: [ShortsService] })
export class ShortsModule {}
