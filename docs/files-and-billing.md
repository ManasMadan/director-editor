# Files and billing

Both are optional: files are on when `S3_BUCKET` is set, billing when `STRIPE_SECRET_KEY`
and both prices are. Off, their procedures answer `FEATURE_DISABLED` and clients hide
them (`system.info`).

## Files

### Upload flow

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

### Storage

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

### Locally

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

## Billing

Billing is per organization, on Stripe (`apps/api/src/modules/billing`). Stripe is the
source of truth; `billing.customer` and `billing.subscription` mirror it, and
`billing.trial_card` remembers which cards have had a free trial.

### Plans and entitlements

`packages/contracts/src/billing.ts`:

| Plan | Members | Customer webhooks |
|---|---|---|
| `free` | 3 (pending invitations count) | no |
| `pro` | unlimited, billed per seat | yes |

The Pro plan has a monthly and a yearly price (`STRIPE_PRICE_PRO_MONTHLY`,
`STRIPE_PRICE_PRO_YEARLY`). A subscription that is `trialing`, `active` or `past_due`
gives Pro (a failed payment keeps the plan while Stripe retries); anything else lapses to
Free. With billing off, every organization has every entitlement.

Checks happen where the feature is used: `BillingService.require(orgId, "webhooks")`
throws `ENTITLEMENT_REQUIRED`, and the member limit is enforced by better-auth's
organization plugin (`membershipLimit`, and `beforeCreateInvitation` in
`apps/api/src/auth/auth-plugins.ts`). Clients read the plan and entitlements from
`billing.overview` to hide or badge features.

To add an entitlement: add it to both plans, check it with `require` where the feature
is used, and hide or badge it in the clients.

### Flow

- Every `billing.*` procedure is for owners and admins (`orgAdmin`).
- `billing.checkout` creates the Stripe customer the first time, with
  the organization id in its metadata, and returns a Checkout URL. A workspace has one
  checkout open at a time, kept in Redis (`billing:checkout:<org>`): asking again for the
  same offer (price, seats, trial) returns that session while it's open, and a new session
  (another interval, or the member count changed) expires the one before, so two admins
  or two tabs can't end up paying for two subscriptions. Requests that race each other send
  the same idempotency key, which names the previous session and the offer, so Stripe
  answers them with one session and never replays a closed one. If two live subscriptions
  appear anyway, sync logs an error naming both, for someone to refund one.
- The first subscription of a workspace gets a `STRIPE_TRIAL_DAYS` trial, and each card
  gets one trial: when sync sees a trialing subscription, it claims the card's Stripe
  fingerprint (the same for a card in every customer) in `billing.trial_card`, and a
  subscription whose card was already claimed by another has its trial ended at once
  (`trial_end: "now"`, so Stripe charges the card), so new workspaces or accounts can't
  farm trials. Only cards have fingerprints; a trial paid another way, or started without
  a card (`payment_method_collection: "if_required"`), keeps it, and Stripe Radar rules
  can cover those.
- `billing.portal` opens Stripe's billing portal; `billing.invoices` lists past invoices.
- Stripe's events arrive at apps/webhooks, `POST /webhooks/stripe`: the signature is
  checked against `STRIPE_WEBHOOK_SECRET`, the event is stored once in
  `webhooks.inbound_event` (unique on Stripe's id) together with a
  `stripe.event_received.v1` outbox row, and the route answers at once.
- The relay hands it to the API's `events-billing` consumer, which re-reads the
  subscription from Stripe and overwrites the row, so duplicate or out-of-order events
  can't leave stale state. A failed renewal also notifies the organization's owners and
  admins (`billing.payment-failed`).
- Members joining or leaving update a paid plan's seat count.
- Deleting an organization, or an account that solely owns one, cancels its subscription.

### Locally without a Stripe account

`packages/fake-stripe` is a stateful stand-in for the parts of Stripe the app uses:
customers, Checkout, the billing portal, subscriptions, invoices and the cards they're
paid with. It checks the secret key, honours `Idempotency-Key` (and refuses a key reused
with other parameters, as Stripe does), sends signed webhooks to apps/webhooks like Stripe does,
and answers 404 to anything it doesn't implement, so a new Stripe call fails loudly until
it's added. Hosted pages at `/checkout/<session>` (pay, pay with a declined card, go back)
(a posted `card` names the card, so tests can pay twice with the same one) and
`/portal/<session>` (cancel or resume); test hooks under `/__fake/` make a renewal fail
or a subscription lapse.

```sh
bun run env:set STRIPE_SECRET_KEY=sk_test_local
bun run env:set STRIPE_WEBHOOK_SECRET=whsec_local
bun run env:set STRIPE_PRICE_PRO_MONTHLY=price_pro_monthly
bun run env:set STRIPE_PRICE_PRO_YEARLY=price_pro_yearly
bun run env:set STRIPE_API_URL=http://127.0.0.1:12111
bun run stripe:fake              # on :12111 (STRIPE_FAKE_PORT)
```

Any `sk_test_`/`whsec_` values work; the price ids must start with `price_`. The
end-to-end suite starts it the same way (`scripts/e2e.ts`), and the API's integration
tests start it in-process (`startFakeStripe`).

### Real Stripe test mode

Every call the api makes is also checked against Stripe's test mode weekly
(`packages/fake-stripe/src/contract.test.ts`, run by `stripe.yml` with the
`STRIPE_CONTRACT_SECRET_KEY` secret), so the fake can't drift from Stripe unnoticed. To
run it yourself: `STRIPE_CONTRACT_SECRET_KEY=sk_test_… bunx vitest run src/contract.test.ts`
in `packages/fake-stripe`. Hosted Checkout, the portal's pages and webhooks still need a
person, as below.

Use your `sk_test_` key and two recurring prices, leave `STRIPE_API_URL` empty, and
forward events:

```sh
stripe listen --forward-to localhost:3004/webhooks/stripe
bun run env:set STRIPE_WEBHOOK_SECRET=whsec_...     # the secret it prints
```
