import { Module } from "@nestjs/common";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysService } from "./api-keys.service";

@Module({ providers: [ApiKeysRepository, ApiKeysService], exports: [ApiKeysService] })
export class ApiKeysModule {}
