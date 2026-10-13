import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { queuePrefix } from "@repo/jobs";
import { FilesModule } from "../files/files.module";
import { MaintenanceProcessor } from "./maintenance.processor";

@Module({
  imports: [
    BullModule.registerQueue({ name: "maintenance", prefix: queuePrefix("maintenance") }),
    FilesModule,
  ],
  providers: [MaintenanceProcessor],
  exports: [MaintenanceProcessor],
})
export class MaintenanceModule {}
