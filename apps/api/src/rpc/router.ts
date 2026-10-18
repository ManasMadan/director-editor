/**
 * The full API router. `os.router` checks it against the contract: a procedure that is
 * in packages/contracts but not implemented here (or vice versa) is a compile error.
 *
 * To add a feature: define its procedures in packages/contracts/src/api, write a module
 * under src/modules/<feature> (module, service, repository, router), register the module
 * in app.module.ts and its router below.
 */
import type { INestApplicationContext } from "@nestjs/common";
import { AssetsService, assetsRouter } from "../modules/assets";
import { DirectorService, directorRouter } from "../modules/director";
import { FilesService, filesRouter } from "../modules/files";
import { PublishService, publishRouter } from "../modules/publish";
import { RealtimeService, realtimeRouter } from "../modules/realtime";
import { RecordingService, recordingRouter } from "../modules/recording";
import { systemRouter } from "../modules/system";
import { AvatarService, userRouter } from "../modules/user";
import type { Procedures } from "./procedures";

export function createRouter(procedures: Procedures, app: INestApplicationContext) {
  return procedures.os.router({
    system: systemRouter(procedures),
    user: userRouter(procedures, app.get(AvatarService)),
    realtime: realtimeRouter(procedures, app.get(RealtimeService)),
    files: filesRouter(procedures, app.get(FilesService)),
    director: directorRouter(procedures, app.get(DirectorService)),
    assets: assetsRouter(procedures, app.get(AssetsService)),
    publish: publishRouter(procedures, app.get(PublishService)),
    recording: recordingRouter(procedures, app.get(RecordingService)),
  });
}

export type AppRouter = ReturnType<typeof createRouter>;
