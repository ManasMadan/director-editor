/** Needs the files profile (RustFS on :59000): `bun run test:integration:files`. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { S3Storage } from "../src/storage";

const storage = new S3Storage({
  bucket: "uploads",
  region: "us-east-1",
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:59000",
  accessKeyId: "rustfs",
  secretAccessKey: "rustfs-secret",
  forcePathStyle: true,
});

describe("S3Storage", { tags: ["files"] }, () => {
  it("uploads through a presigned PUT and serves it through a presigned GET", async () => {
    const key = `quarantine/test/${randomUUID()}.txt`;
    const body = "hello from a browser";
    const upload = await storage.presignUpload({
      key,
      contentType: "text/plain",
      contentLength: body.length,
    });

    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body });
    expect(put.status).toBe(200);
    expect(await storage.head(key)).toEqual({ size: body.length, contentType: "text/plain" });

    const { url } = await storage.presignDownload(key, { filename: "note.txt" });
    const get = await fetch(url);
    expect(await get.text()).toBe(body);
    expect(get.headers.get("content-disposition")).toContain("attachment");

    const final = key.replace("quarantine/", "files/");
    await storage.move(key, final);
    expect(await storage.head(key)).toBeNull();
    await storage.delete(final);
    expect(await storage.head(final)).toBeNull();
  });

  it("rejects an upload whose content type differs from the signed one", async () => {
    const key = `quarantine/test/${randomUUID()}.png`;
    const upload = await storage.presignUpload({ key, contentType: "image/png", contentLength: 4 });
    const put = await fetch(upload.url, {
      method: "PUT",
      headers: { ...upload.headers, "Content-Type": "text/html" },
      body: "evil",
    });
    expect(put.ok).toBe(false);
    expect(await storage.head(key)).toBeNull();
  });

  it("reads an object back, but not one larger than the caller will take", async () => {
    const key = `files/test/${randomUUID()}.bin`;
    await storage.write(key, Buffer.from("twelve bytes"), "application/octet-stream");
    expect((await storage.read(key, 12)).toString()).toBe("twelve bytes");
    await expect(storage.read(key, 11)).rejects.toThrow(/larger than 11 bytes/);
    await storage.delete(key);
  });
});
