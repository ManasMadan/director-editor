/**
 * The conversational editor, on top of the AI service (apps/ai/app/editor.py), which
 * reads the caller's takes and their index and asks Gemini. The edit itself lives in the
 * browser, so this only passes the request through and checks the answer's shape.
 *
 * Where other editor features join: anything that answers a request without Gemini (a
 * shortcut, the asset picker's own options) goes here, before the AI call, and returns
 * the same `EditorReply`, so the web's `useAskEditor` and its action handlers don't
 * change.
 */
import { Injectable } from "@nestjs/common";
import { type EditorReply, type EditorState, editorReplySchema } from "@repo/contracts/api";
import type { OrgId, UserId, VideoId } from "@repo/contracts/ids";
import { aiCaller, callAi } from "../ai";

interface EditorRequest {
  videoId: VideoId;
  text: string | null;
  audio: string | null;
  audioType: "audio/webm" | "audio/mp4" | "audio/ogg" | null;
  state: EditorState;
}

@Injectable()
export class EditorService {
  async ask(userId: UserId, orgId: OrgId, input: EditorRequest): Promise<EditorReply> {
    return editorReplySchema.parse(
      await callAi((ai) => ai.director.askEditor(aiCaller(userId, orgId), input)),
    );
  }
}
