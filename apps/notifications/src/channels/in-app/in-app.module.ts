import { Module } from "@nestjs/common";
import { InAppChannel } from "./in-app.channel";

@Module({ providers: [InAppChannel], exports: [InAppChannel] })
export class InAppModule {}
