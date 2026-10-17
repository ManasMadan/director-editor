# Files

Optional: files are on when `S3_BUCKET` is set. Off, their procedures answer
`FEATURE_DISABLED` and clients hide them (`system.info`).

## Upload flow

File bytes never pass through our services. An upload goes through quarantine and a
check before anyone can see it:

1. **Presign.** The client calls `files.createUpload` with the purpose, file name, type
   and size. The API refuses anything its purpose doesn't allow (types and size limit in
   `packages/contracts/src/files.ts`; 30 uploads an hour per user), creates a `pending`
   row in `files.file`, and returns a presigned `PUT` for `quarantine/<id>`, valid for
   10 minutes. The signature covers `Content-Type` and `Content-Length`, so the client
   can't swap in a larger or different file.
2. **Upload.** The client `PUT`s the bytes straight to storage with exactly the headers
   it was given.
3. **Complete.** `files.completeUpload` queues a `files` job with the file id as job id,
   so completing twice checks once.
4. **Check** (`apps/worker/src/files/files.processor.ts`): the stored size is within the
   limit (`FILE_TOO_LARGE`) and matches what was declared (`FILE_SIZE_MISMATCH`); ClamAV
   finds nothing (before anything parses the bytes); the real type, sniffed from the
   bytes, is allowed. The checked file is stored, then its row updated, then the
   quarantined original removed, so a retry after a crash either checks the original
   again or only cleans up.
5. **Re-encode.** Per purpose: avatars are decoded and re-encoded as a 512 px WebP (at
   most 50 megapixels in), which drops everything but pixels (EXIF, GPS, embedded
   payloads).
6. Accepted files move to `files/<id>` and become `ready`. Rejected ones are deleted, with
   the reason (`FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE`, `FILE_INFECTED`,
   `FILE_UNREADABLE`). Either way the uploader's screens get a `files.changed` realtime
   nudge. Storage or clamd failures throw, and the job retries.

Pages link to `/api/v1/files/<id>/content`, which checks the session and redirects to a
presigned download valid for 5 minutes, so links never expire. Row-level security keeps
files private to their uploader, except ready avatars, which anyone signed in may read.
A user's picture (`user.image`) is only ever such an avatar, or the profile picture a
social provider gave at sign-up: sign-up and profile updates ignore or refuse a picture
a client sends.

The worker's `files-cleanup` task (hourly) forgets uploads never completed or rejected
after a day, and deletes objects whose row is gone (a trigger queues them in
`files.object_deletion`).

To add a purpose: add it to `uploadPurposes` with its types and limit, decide who may read
it (the files migration's policies), and what processing it gets (the files processor).

## Storage

Everything goes through the `Storage` interface (`packages/nest-common/src/storage.ts`).
`S3Storage` speaks the S3 API; the server is RustFS everywhere, locally (docker compose)
and in every cluster (`deploy/charts/data`). A provider without an S3 API gets its own
`Storage` implementation; callers don't change. Virus scanning is behind `FileScanner`
(`apps/worker/src/files/file-scanner.ts`), clamd today.

Browsers upload to the bucket directly, so it needs CORS for the site's origin (locally
set by the `s3-init` container, in a cluster by the data chart's bucket Job), and the web
app's CSP must allow `STORAGE_ORIGIN`.

In a cluster, the uploads bucket is on a RustFS server of its own, reached by browsers
at a host of its own (`storage.uploads.host` in the environment's `data.yaml`, e.g.
`files.example.com`) through the gateway and Cloudflare. A separate host rather than a
path of the site, so an uploaded file can never run in the site's origin. The data chart
generates its keys into the `storage` Secret, and the stack gives each service what it
needs of it: the api signs URLs for the public host, the worker reads and writes
in-cluster, the web app gets `STORAGE_ORIGIN`. Database backups are on a separate RustFS
server the application has no keys to. Environments without ClamAV (kind, previews)
leave files off.

## Locally

```sh
bun run db:up:full               # adds RustFS and ClamAV; creates the uploads bucket
bun run env:set S3_BUCKET=uploads
```

`bun dev:full` starts them too. ClamAV takes about 1.5 GB of memory and a few minutes on
its first start to download signatures. `FILE_SCANNER=none` skips scanning while you work
on something else (refused in production). The RustFS console is at
http://localhost:59001.

The local ClamAV can stop answering after running for some hours: uploads then stay
`pending` and the worker's logs show `clamd timed out`. `docker compose restart clamav`
brings it back (it keeps its signatures, so it's quick).
