import { Module } from "@nestjs/common";
import { AppsRepository } from "./apps.repository";
import { AppsService } from "./apps.service";

@Module({ providers: [AppsRepository, AppsService], exports: [AppsService] })
export class AppsModule {}
