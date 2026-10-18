/** What YouTube gets from the publish sheet's copy, and which copy the API refuses. */
import { describe, expect, it } from "vitest";
import { directorCutIdSchema, videoIdSchema } from "../ids";
import {
  descriptionBytes,
  fitsYouTube,
  PUBLISH_DESCRIPTION_MAX_LENGTH,
  publishContract,
  publishCopySchema,
  youtubeDescription,
  youtubeTitle,
} from "./publish";

const videoId = videoIdSchema.parse("dQw4w9WgXcQ");
const cutId = directorCutIdSchema.parse("0199f3a0-0000-7000-8000-000000000001");
const copy = { title: "My look", description: "", hashtags: [], credits: "" };
const uploadInput = publishContract.upload["~orpc"].inputSchema;

describe("youtubeTitle", () => {
  it("adds #Shorts once", () => {
    expect(youtubeTitle("  My look ")).toBe("My look #Shorts");
    expect(youtubeTitle("My look #shorts")).toBe("My look #shorts");
  });
});

describe("youtubeDescription", () => {
  it("ends with the hashtags, then the credits and the original Short", () => {
    expect(
      youtubeDescription(
        { description: " Three outfits. ", hashtags: ["grwm", "fitcheck"], credits: "By @maya" },
        videoId,
      ),
    ).toBe("Three outfits.\n\n#grwm #fitcheck\n\nBy @maya\nhttps://youtube.com/shorts/dQw4w9WgXcQ");
  });

  it("leaves out the parts that are empty", () => {
    expect(youtubeDescription({ description: "", hashtags: [], credits: " " }, videoId)).toBe(
      "https://youtube.com/shorts/dQw4w9WgXcQ",
    );
  });

  it("counts bytes, as YouTube does", () => {
    expect(descriptionBytes("aé")).toBe(3);
    expect(descriptionBytes("あ😀")).toBe(7);
  });
});

describe("the copy", () => {
  it("takes words in any script as hashtags, without their #", () => {
    expect(publishCopySchema.safeParse({ ...copy, hashtags: ["सफ़र", "grwm_2"] }).success).toBe(
      true,
    );
    for (const hashtags of [["#grwm"], ["two words"], [""]]) {
      expect(publishCopySchema.safeParse({ ...copy, hashtags }).success, hashtags[0]).toBe(false);
    }
  });

  it("refuses angle brackets, which YouTube won't take", () => {
    for (const field of ["title", "description", "credits"] as const) {
      expect(publishCopySchema.safeParse({ ...copy, [field]: "a <b>" }).success, field).toBe(false);
    }
  });
});

describe("the upload's input", () => {
  it("is unlisted unless asked otherwise", async () => {
    const parsed = await uploadInput?.["~standard"].validate({ ...copy, cutId });
    expect(parsed && "value" in parsed && parsed.value).toMatchObject({ visibility: "unlisted" });
  });

  it("fits YouTube's description limit counted in bytes, link and all", () => {
    const fits = (description: string) =>
      fitsYouTube({ description, hashtags: ["grwm"], credits: "By Maya" });
    expect(fits("a".repeat(PUBLISH_DESCRIPTION_MAX_LENGTH))).toBe(true);
    // Within the length limit, but three bytes a character.
    expect(fits("あ".repeat(1_700))).toBe(false);
  });

  it("refuses a description that would run past YouTube's limit in bytes", async () => {
    // Within the length limit, but three bytes a character.
    const description = "あ".repeat(PUBLISH_DESCRIPTION_MAX_LENGTH);
    const parsed = await uploadInput?.["~standard"].validate({ ...copy, description, cutId });
    expect(parsed && "issues" in parsed && parsed.issues?.[0]?.path).toEqual(["description"]);
  });
});
