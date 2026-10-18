# Files

Optional: files are on when the chosen `STORAGE_PROVIDER` has its bucket (`S3_BUCKET`
for `s3`, `GCS_BUCKET` for `gcs`; `filesEnabled` in `packages/nest-common/src/storage.ts`
decides, for the api and the worker alike). A half-configured provider (`gcs` without
`GCS_BUCKET`, or the other provider's bucket set) stops the service at boot. Off, their
procedures answer `FEATURE_DISABLED` and clients hide them (`system.info`).

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

Everything goes through the `Storage` interface (`packages/nest-common/src/storage.ts`),
chosen by `STORAGE_PROVIDER`. `S3Storage` speaks the S3 API; the server is RustFS
locally (docker compose) and in kind (`deploy/charts/data`). `GcsStorage` speaks GCS's
own JSON API with Application Default Credentials (no key file): production's bucket.
A provider with neither API gets its own `Storage` implementation; callers don't change.
Virus scanning is behind `FileScanner` (`apps/worker/src/files/file-scanner.ts`), clamd
today.

Browsers upload to the bucket directly, so it needs CORS for the site's origin (locally
set by the `s3-init` container, in a cluster by the data chart's bucket Job, in
production the bucket's own CORS configuration), and the web app's CSP must allow
`STORAGE_ORIGIN`.

Director's spoken guide lines (`director.speak`) are kept under `director/speech/`, shared
by every workspace. In production the bucket's lifecycle rule deletes them 90 days after
they were made, so the cache can't grow forever; a line asked for again is simply made
again. Set it with `gsutil lifecycle set` on the bucket (`age: 90`,
`matchesPrefix: ["director/speech/"]`), and check it with `gsutil lifecycle get`.

Director's continuous recording keeps its raw footage under `recordings/<session>/<part>/<slice>`
(apps/api's `recording` module). Slices aren't uploads: the API signs a PUT for exactly
each slice (its size and the recorder's type) with no `files.file` row, quarantine or
virus scan, since nothing ever serves or shows them. The API checks a part's first slice
starts as its declared type does (`RECORDING_SLICE_INVALID` otherwise, and the slice is
deleted). Only the clipper decodes them, as that type only, from local files only, with
no secrets in its environment and its CPU, file size and memory capped (in production on
Cloud Run, never in the ai pod: [deploy.md](deploy.md#the-cloud-run-clipper)), and
the take it makes is its own re-encode, stored by the worker as a ready
`director-take-video` file of the member's. Deleting a session (or its expiry, run by the
worker's `recording-retention` task) queues each slice's object in
`files.object_deletion`, which `files-cleanup` drains. In production the bucket's
lifecycle rule on `recordings/` (15 days, [deploy.md](deploy.md#the-cloud-run-clipper),
still to be applied) is the backstop.

In a cluster, the uploads bucket is on a RustFS server of its own, reached by browsers
at a host of its own (`storage.uploads.host` in the environment's `data.yaml`, e.g.
`files.example.com`) through the gateway and Cloudflare. A separate host rather than a
path of the site, so an uploaded file can never run in the site's origin. The data chart
generates its keys into the `storage` Secret, and the stack gives each service what it
needs of it: the api signs URLs for the public host, the worker reads and writes
in-cluster, the web app gets `STORAGE_ORIGIN`. Database backups are on a separate RustFS
server the application has no keys to. Environments without ClamAV (kind, previews)
leave files off.

In production, `STORAGE_PROVIDER=gcs` and `GCS_BUCKET` (api, worker) point at
`director-media-…` instead: no service gets the `storage` Secret (`storage: none` in
`deploy/environments/production/stack.yaml`; the data chart's RustFS still runs, unused
by the app), no access keys. The VM's service
account needs `roles/storage.objectAdmin` on the bucket to read and write it, and
`roles/iam.serviceAccountTokenCreator` on itself, since Application Default Credentials
from the metadata server have no private key to sign a URL with: `getSignedUrl` falls
back to the IAM Credentials API's `signBlob` instead. Pods reach the metadata server
(169.254.169.254) through `allowMetadataServer: true` in the stack chart, since it's
otherwise unreachable like the rest of `networkPolicy.privateRanges`. `web` gets
`STORAGE_ORIGIN=https://storage.googleapis.com`, where GCS's signed URLs are: the CSP
adds it to `connect-src` (uploads) and `media-src` (takes playing from storage). Signed
uploads bind Content-Type and Content-Length, as on
S3 (`X-Goog-SignedHeaders=content-length;content-type;host`).

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
