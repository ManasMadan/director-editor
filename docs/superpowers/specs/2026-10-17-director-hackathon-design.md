# Director for the Google Cloud hackathon: design

Status: agreed with the owner on 2026-10-17. Submission is 2026-10-18; everything below
is in scope, and work continues after the deadline on the same link
(https://director.mmadan.in). The product should feel exceptional, not merely complete.

## Intent

Director turns any YouTube Short into a template that a first-time creator can follow,
shot by shot, with Gemini directing them live through their phone camera, and then
publish their own version to YouTube Shorts. It is a hackathon entry for the problem
"AI that transforms how content is created", so it must:

- feel like a polished, standalone third-party product a YouTube team could buy and
  integrate, not a starter template with a feature bolted on;
- visibly run on Google Cloud (Gemini on Vertex AI, Cloud Run, Cloud Storage, and more
  where they add something real);
- let judges try it in a minute: a landing page that explains it, and demo credentials
  on the sign-in page.

## The flow (the owner's, kept as is)

1. **Landing page** explains the product and its features, and sends judges to sign in.
2. **Sign in** with email and password (a demo account shown on the page) or with Google.
3. **Library** (the existing feed, kept as the home screen): it shows only the 6
   pre-indexed templates and the Shorts the user has indexed; the open YouTube search
   feed goes, so nothing gets indexed by accident. Plus one slot to index the user's
   own Short by pasting a YouTube link. Indexing runs in the background on a Cloud Run
   worker. Each user can index exactly one Short; a second attempt shows a friendly
   pop-up: no more indexing, because AI credits are limited for the demo.
4. **Template**: pick one of the (up to) 7. It shows what Gemini understood: the shots,
   what each scene represents, the script, angles.
5. **Shoot**: a Gemini video call. Director becomes a live call with Gemini (Gemini
   Live, voice to voice): it sees through the phone camera, speaks directions in a
   natural voice, and the user can talk back and interrupt ("like this?"). It can act
   for them by voice: start recording, move to the next shot, retake. The screen looks
   like a video call: the camera full screen, Gemini's animated presence, live captions
   of what each side says, on top of today's Director Live guides (teleprompter,
   captions, doodles, stick buddy, angle and tilt guides). If the call can't start
   (network, browser), Director Live works as today.
6. **Takes**: every take of every shot is kept (a shot may have 1 or 9). Gemini reviews
   each take as it arrives (best part, score, one thing to fix) and, when none of a
   shot's takes is good enough, says so and asks for another ("Shot 4: let's go again,
   your face was in shadow"). The user can also retake any shot whenever they like.
7. **Edit**: Gemini picks the best take of each shot and assembles the final video from
   them, on the template's timings, with its captions and audio. The user can override
   any pick. The editor is a timeline built for a first-time creator, not a power user:
   scroll sideways through the video's shots, scroll down a shot to see its takes
   stacked, Gemini's pick highlighted, and a stepper per shot to choose another take.
   The user saves the result as a final video.
8. **My media**: the saved final videos, grouped by template. One template can have
   many final videos.
9. **Publish to YouTube Shorts** from inside the app, any saved final video: Gemini writes the title,
   description, hashtags and credits (the original creator, and the music); the user
   reviews and edits them, then uploads to their own channel.

## Goals

- **Indexing works for any Short.** The core of the product. Whatever the video (a
  talking head, a product shot, a recipe, a dance, a landscape with text, no person at
  all, no speech, fast cuts, on-screen text), Gemini produces a valid, useful template
  that fills everything the shooting features read:
  - teleprompter and captions: the script, word for word, with timings;
  - doodles: the pose (or none), the landmark, the framing box, camera moves;
  - the angle and tilt guide: phone pitch, roll and height;
  - what each scene represents and why (purpose), and where to be (scene);
  - the shot list itself: one shot per cut, with source timings and durations.
- **The 6 seeded templates are copies, not shared rows.** They are indexed once, kept in
  the repository as fixed data, and copied into every new workspace when it is created
  (sign-up creates a personal workspace). Copies don't count against the user's limit.
- **One user-indexed Short per user**, enforced by the API, with the pop-up in the UI.
- **Bloat gone.** Everything from the starter that isn't Director is removed or, where
  it is load-bearing, hidden (see "Removal").
- **Google Cloud visible and real.** See "Google Cloud".
- **Landing page** that makes judges get it in one screen, and **demo credentials** on
  the sign-in page.
- **Publish to YouTube** works end to end for a signed-in Google user.
- **Every loading and waiting state looks like Gemini**: shimmering gradients and
  sparkle animation, never a plain spinner.

## Non-goals

- No change to the editing style itself (how the cut, captions and doodles look). The
  work goes into indexing reliably feeding the existing features.
- No mobile app (apps/mobile goes).
- No billing, teams, invitations, API keys, MCP, webhooks for third parties.
- Not a multi-tenant product: one personal workspace per user, invisible to them.

## Anti-goals (would make it a failure even if it works)

- Looking like a template: "Director-editor", "Ship your idea this weekend", todos,
  workspace switchers, billing pages, a generic dashboard anywhere in the UI.
- Fake progress or fake results presented as live. Anything pre-recorded is labelled.
- Uploading to YouTube without the user seeing and confirming every field.
- Re-uploading the original creator's footage.
- Running out of the $300 credits before the demo period ends (30-40 days from
  2026-10-17).

## Constraints

- Deadline: tomorrow for the submission; everything is in scope and work continues after
  it, in the order in "Order of work".
- Budget: $300 of GCP credits for 30-40 days; the VM is the main cost. AI spend must be
  capped (indexing limit, per-org token budget already exists).
- GCP org policies block service-account key files (and, by default, SA-bound API keys
  and HMAC keys). Prefer the VM's own service account (metadata server) for Google APIs
  that can't take an API key; that needs the VM's access scope widened to
  cloud-platform, which means one stop/start of the VM (a few minutes of downtime).
- Cloudflare free plan: hosts stay one level under director.mmadan.in.
- Production deploys from master through Argo CD; the owner accepts moving pieces to
  Google products where that shows off Google Cloud better.

## Decided

- 6 pre-indexed + 1 own per user, the credits pop-up, Cloud Run for indexing, template
  -> many attempts, a media gallery, YouTube upload with Google sign-in, landing page,
  demo credentials (the owner).
- Seeded templates are copied into each new workspace at creation (the owner).
- The 6 Shorts are picked by the builder for variety; the owner reviews and may swap
  them (the owner).
- Editing style stays as it is (the owner).
- Takes, picks and final videos as in steps 6-8 of the flow, and the timeline editor
  (the owner).
- Indexing on the most capable model (Gemini 4 Argon), everything interactive on
  Flash (the owner).
- Shoot becomes a Gemini video call, voice to voice (the owner).
- Every loading state is Gemini-styled (the owner).
- The Library replaces the YouTube search feed (the owner).
- Publishing with the original audio is acceptable (the owner).
- The demo account can index one Short like any user; publishing is off on it, with a
  note that signing in with Google allows publishing (the owner).
- One VM stop/start (about 5 minutes of downtime) is fine (the owner).
- The builder runs every Google Cloud and production step with the project access it
  already has; the owner only does what needs the Cloud Console's UI (the OAuth client
  and consent screen), from exact steps the builder gives (builder's call).

## Indexing (the heavy part)

Today: the AI service's worker sends Gemini the YouTube URL and asks for a `ShotPlan`
(apps/ai/app/director.py, schemas in apps/ai/app/schemas.py). The schema already has
everything the shooting features read. The work is making it reliable for any video:

- **The prompt** covers the cases that break it today: no person in shot (pose empty,
  framing is the object), no speech (empty script, captions from on-screen text where
  that is the point of the Short), on-screen text and doodles in the original (carry
  them as script/caption lines or steps), fast cuts (one shot per cut, merge sub-second
  cuts so no shot is shorter than the minimum), photo slideshows (photo shots), and a
  Short longer than the shot cap (merge adjacent shots rather than fail).
- **What each scene represents**: the shot's `purpose` and `scene` say what the moment
  does in the story (hook, reveal, payoff) and what the viewer should feel.
- **Validation and repair**: timings are clamped and made consistent (shots in order,
  inside the video, durations sum close to the video's length; script lines inside
  their shot), instead of failing the whole index for one bad number. Only a structurally
  unusable answer fails, with a clear message.
- **Video input settings**: sample frames densely enough to catch Shorts' fast cuts
  (about 3 fps) at medium resolution; high resolution only if on-screen text is missed.
- **Models** (the owner): indexing is a background task, so it uses the most capable
  model: Gemini 4 Argon (`gemini-4-argon`, released 2026-10-13, verified to answer in
  this project). Everything the user waits on uses Flash for speed: scene checks, take
  reviews, picks, publish copy (`gemini-3.8-flash`), and the live call (the newest
  Gemini Live native-audio model available on Vertex). Re-check model IDs at build time;
  newer ones may appear.
- **Evaluation**: a set of about 12 varied Shorts (the 6 seeds plus 6 hard cases:
  no person, no speech, fast cuts, slideshow, product, text-heavy) indexed in one run,
  each checked against the fields above; the bar is "every one indexes, and every
  template is shootable".
- **Progress**: the library slot shows real stages while indexing (queued, watching,
  writing the template, ready, or failed with a reason), from the status the worker
  already publishes.

Cloud Run's part: the Gemini call for indexing (and the parsing, validation and repair)
runs in a private Cloud Run service built from the same AI image. The existing worker
queues and retries the job, calls the Cloud Run service with a Google-signed identity
token, and writes the returned template to Postgres. Cloud Run never touches the
database.

## Original audio

When a Short is indexed, its audio track is downloaded once (yt-dlp) and stored with the
template, so recording can play it and the final video can carry it. YouTube often
blocks such downloads from cloud servers: the 6 seeded Shorts' audio is downloaded from
the owner's machine and stored with the seeds, so they always have it (builder's call).
When the download fails for a user's Short, the template says plainly that the original
audio couldn't be fetched and that recording uses the phone's mic instead.

## Google Cloud

All of these are in scope:

1. **Gemini on Vertex AI**: Gemini 4 Argon for indexing; Gemini 3.8 Flash for scene
   checks, take reviews and the YouTube publish copy. Already on Vertex.
2. **Gemini Live API (native audio)**: the voice-to-voice director call. It needs
   OAuth credentials rather than an API key, so the API relays the call to Vertex with
   the VM's own service account.
3. **Cloud Run**: the indexing service above.
4. **Cloud Storage**: takes and finished edits move from the in-cluster object store to
   a GCS bucket (signed URLs for the browser; Gemini reads takes from the bucket).
5. **YouTube Data API**: the library's metadata (already), and publishing.
6. **Gemini TTS** (`gemini-3.8-flash-tts`): Director's spoken directions in a Google
   voice when the live call isn't running, instead of the browser's.
7. **BigQuery**: an event log of indexings, takes and scores, and one Looker Studio
   dashboard for the pitch. Stretch.
8. **Veo 3.1**: a short "show me the shot" clip for each shot of the 6 seeded
   templates (reachable in this project; Lite to keep cost down).
9. **Lyria**: royalty-free music matched to the original's mood and tempo, as an
   alternative to the original audio (lyria-002 is reachable; use Lyria 3 if its ID is
   found).
10. **Nano Banana 2.1** (Gemini image): storyboard cards for each shot on the template
    page.

Not used: Imagen (deprecated on Vertex), Cloud Translation (Gemini already writes in the
user's language), Speech-to-Text (Gemini already transcribes during indexing, and the
live call transcribes itself).

## Removal

Remove: todos and the dashboard, the documents assistant and RAG (keep the AI service,
its client and token accounting, which Director needs), MCP servers and the OAuth
provider plugins, billing and Stripe, API keys, outbound webhooks (keep the webhooks app
for the mail server's delivery feedback), SMS, push, the in-app notification inbox and
preferences (keep email: sign-in codes go through it), the audit log UI, the mobile app,
load tests, and their docs, CI jobs, env vars, charts and translations.

Hide (load-bearing): workspaces. Every Director table and permission is scoped to a
workspace, and each user gets a personal one at sign-up; remove the switcher, members,
invitations and workspace settings from the UI.

Rename everything user-facing from "Director-editor" to "Director".

## Demo credentials

A demo account (email and password shown on the sign-in page) with the 6 templates and
some takes and final videos the owner records. It can index one Short (shared by every
judge who uses it); publishing is off on it. Created once in production by a deliberate command, not
by the development seed (which refuses to run in production). Sign-up stays open.

## Publish to YouTube

- Sign in with Google asks only for basic profile. The `youtube.upload` permission is
  asked for when the user first taps Publish (incremental consent).
- The publish sheet shows the video, and Gemini's title, description, hashtags and
  credits, all editable; nothing uploads without the tap.
- Uploads go up vertical, under 3 minutes, unlisted by default with a visibility choice.
  If YouTube still forces uploads from an unverified project to private, the app says
  "Uploaded as private" honestly (the builder tests one upload first).
- Credits name and link the original Short; the final video may carry the original
  audio (the owner accepts the copyright risk).
- The owner creates the Google OAuth client and consent screen (the builder gives exact
  steps); the app may stay unverified for the hackathon.

## Order of work (all in scope)

1. Indexing reliability for any Short (Gemini 4 Argon), with the evaluation set.
2. 6 seeded templates copied into every workspace; one own index per user with the pop-up.
3. Bloat removal and the rename.
4. Landing page and demo credentials.
5. Sign in with Google and publish to YouTube; My media gallery.
6. Cloud Run indexing service.
7. Cloud Storage for media.
8. The Gemini video call (Live API) in Shoot, and Gemini TTS for the guides.
9. BigQuery and a dashboard; Veo clips; Lyria music; storyboard cards.

## Left to the builder

- Which 6 Shorts (varied kinds of shoot; public, under a minute, with a clear shot
  structure); the owner reviews them.
- The landing page's design and copy, within the anti-goals above.
- How seeded templates are stored and copied, how the per-user limit is counted, and
  the indexing-progress UI.
- Database changes, following the repo's expand/contract rules.
- Whether the gallery is a new page or the existing review page grown into one.
