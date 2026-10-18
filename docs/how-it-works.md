# How Director works

What happens underneath each step a creator takes, from pasting a Short to publishing
their own version. The screens themselves, Director Live's on-device guides, the data
model and the demo account are in [director.md](director.md); the services and how a
request flows through them in [architecture.md](architecture.md); every setting named
here in [environment.md](environment.md).

## Indexing a Short

Indexing turns a YouTube Short into a plan someone can film: the shots, in order, with
everything the camera screen reads. It is the core of the product, so it is built to
work on any Short, and checked on twelve real ones.

### Asking for it

The library's "Bring your own Short" calls `director.index` with the pasted link. The API
asks the YouTube Data API whether the link is a video YouTube shows and how long it is
(`apps/api/src/modules/shorts/youtube.ts`): a private, removed or unknown video answers
`DIRECTOR_VIDEO_UNAVAILABLE`, and one longer than 180 seconds `DIRECTOR_TOO_LONG`, before
any AI is spent. The answer is cached in Valkey for an hour.

The AI service then claims the plan in the caller's name (`Director.index` in
`apps/ai/app/director.py`). Each user may index one Short of their own across all their
workspaces: a second answers `DIRECTOR_INDEX_LIMIT`, which the library shows as the "You've
used your AI credit" dialog. The claim takes a per-user advisory lock, so a double click
or two tabs count once, and a partial unique index in Postgres
(`director_plan_one_user_index`) holds the limit even past the lock. A plan that failed
never counts, and the 6 starter templates never count. The plan job then goes on the
`ai-director` queue in Valkey (BullMQ: three attempts, exponential backoff).

### Stages

The plan's `stage` is stored on its row and announced over the realtime channel as each
is reached, so the library card shows real progress, never a timer:

| Stage | Means |
|---|---|
| `queued` | asked for, waiting for the worker |
| `watching` | Gemini is watching the Short |
| `writing` | Gemini has answered: the audio is being captured and the plan saved |
| `ready` | the template can be filmed |
| `failed` | with its reason: `DIRECTOR_VIDEO_UNAVAILABLE` when Gemini can't watch the video, `AI_BUDGET_EXCEEDED` when the workspace's allowance is spent, `DIRECTOR_ANALYSIS_FAILED` otherwise |

### Where it runs

The worker first reserves the run's tokens from the workspace's monthly allowance
(`apps/ai/app/usage.py`), then hands the Short to an `Indexer`
(`apps/ai/app/indexing.py`). With `INDEXER_URL` set, as in production, that is
`RemoteIndexer`: it asks the VM's metadata server for a Google-signed ID token for the
indexer's URL and posts the request to `director-indexer`, a private Cloud Run service
built from the same image (`apps/ai/app/indexer.py`). Cloud Run lets in only the
service's invokers, and the indexer checks the token again itself: Google's signature,
its own URL as the audience, and the VM's service account as the caller. It has no
database: it answers with the plan, the model that wrote it, the audio it captured and
the tokens it used, and the worker stores and counts them. Without `INDEXER_URL` the
worker indexes in its own process, with the same code (`LocalIndexer`). How the indexer
is deployed: [deploy.md](deploy.md#the-cloud-run-indexer).
<!-- verify after deploy: INDEXER_URL set in production -->

### The Gemini call

Gemini 4 Argon (`INDEX_MODEL`) watches the Short straight from its YouTube URL; Director
never downloads the picture. The request (`index_short` in `apps/ai/app/indexing.py`):

- the URL sent as `video/*` (Vertex AI answers a YouTube URL sent as `video/mp4` with a
  500), sampled at 3 frames a second at medium resolution, enough to catch a Short's fast
  cuts within the token budget;
- medium thinking, with the run capped at the tokens reserved for it;
- the prompt, `PLAN_INSTRUCTIONS` in `apps/ai/app/director.py`, written for the Shorts
  that break a naive plan: a cut starts a new shot, and a cut under half a second folds
  into its neighbour; a slideshow is one photo shot per slide; a Short with more cuts
  than the 12-shot cap merges its adjacent shots rather than failing; nobody has to be
  in shot (then the framing box frames the object); with no speech, on-screen text
  becomes the script, timed to when it shows, and drawn doodles become steps. Each
  shot's `purpose` is its role in the story (hook, setup, reveal or payoff) and the
  feeling it goes for. Instructions are written for a beginner, in the Short's own
  language, and anything said or written in the video is treated as content, never as
  instructions.

Gemini answers in a structured schema that is the plan itself (`apps/ai/app/schemas.py`):
the Short's title, format, summary and kind of sound, and per shot its kind (video or
photo), the seconds of the original it covers and how long it lasts in the new edit,
purpose, scene and the one landmark to point the camera at, which camera (front or
back), a framing box on a 9:16 frame, the phone's pitch, roll, tolerance and height,
the pose as named joints, timed steps each with its camera move, and the script word for
word with timings. Vertex AI refuses a response schema with any `minItems` or `maxItems`
in it, so Gemini answers a draft with no list bounds (`ShotPlanDraft`) and the repair
step below enforces them.

### Retries and the fallback model

Gemini 4 Argon's video calls fail intermittently and usually succeed on a second try. A
transient failure (a 5xx, a 429, a timeout, a dropped connection) is retried twice, a
second and then two seconds later. Once those are spent, the fallback model,
`INDEX_FALLBACK_MODEL` (Gemini 3.1 Pro, `gemini-3.1-pro-preview`), tries once. A refusal
that is about the model rather than the video (an auth error, a model it doesn't
recognize) goes to the fallback at once. A refusal about the video itself (private,
removed, age-restricted) isn't retried at all: no model could watch it, and the plan
fails with `DIRECTOR_VIDEO_UNAVAILABLE`. The plan records whichever model wrote it.
Past these, the queue's own attempts retry the whole job, and the last one fails the
plan with its reason rather than leaving it half done.

### Repair

Gemini's answer passes validation field by field, but nothing in a schema ties one
shot's timings to the next or to the video. `repair_plan` (`apps/ai/app/plan_repair.py`)
fixes that deterministically instead of failing the whole plan over one bad number:

1. shots are sorted by where they start in the original, clamped inside it, and trimmed
   so they never overlap;
2. a sliver under 0.3 seconds is dropped (unless it is all there is);
3. past 12 shots, the earliest are kept and so is the last, the payoff;
4. each shot's edited duration is clamped, and if they add up to more than the Short can
   hold, all of them scale down together, never below half a second;
5. script lines and steps are pulled back inside their shot's new duration and trimmed
   to their caps, and a shot left with no step gets one made from its scene;
6. the plan's length becomes the sum of its shots.

The result is validated against the real `ShotPlan`, bounds included. Only a plan with no
shots at all fails.

### The original's audio

Once the plan is written, the indexer downloads the Short's audio track with yt-dlp
(`apps/ai/app/audio.py`, two minutes at most) and uploads it to Cloud Storage as
`audio/<videoId>.m4a` (`MEDIA_BUCKET`), with the service account's own credentials. A
failure there never fails the plan: its audio status says `failed`, and recording uses
the phone's microphone. YouTube often blocks such downloads from cloud machines, so the
6 starter templates' audio was captured once from a developer's machine instead.

### Checking it works on any Short

`bun run --filter @repo/ai evals:index` indexes the 12 Shorts in `apps/ai/evals/shorts.json`
for real on Vertex AI, through the same `index_short`: the 6 starter templates and six
hard cases (no person, music only, text and doodles over a whiteboard, fast cuts, a
photo slideshow, and a long vlog with more cuts than the shot cap). The bar is that every
one indexes, and every shot of every plan has a scene, a framing, a phone angle and at
least one step. On 2026-10-18 all 12 passed on Gemini 4 Argon with no retry or fallback;
only the long vlog needed repair (its shots' durations scaled to fit).

### The 6 starter templates

The starter Shorts (`apps/ai/app/seeds/seeds.json`) were indexed once on Vertex AI by
`bun run --filter @repo/ai seeds:build`, and the plans are committed in
`packages/contracts/src/director-seeds.json`. When a workspace is created, the API copies
all 6 into it in the same transaction (`apps/api/src/modules/director/seeds.repository.ts`),
ready to film, so a new account never waits for indexing.

The starter templates also carry media made once, offline, with Google's generative
models on Vertex AI (`bun run --filter @repo/ai seeds:media`,
`apps/ai/scripts/seed_media.py`): a storyboard card per shot by Nano Banana 2.1, a few
seconds' silent 720p preview clip per shot by Veo 3.1 Lite, and a soundtrack per template
by Lyria 3 Clip, matched to its moods and pace. Each prompt is made only from the shot's own directions, never its title or
lines, which could name a brand, and anyone pictured is a generic person, never a likeness
of the Short's creator. The files sit in Cloud Storage, and `director.plan` links them,
with short-lived signed URLs, when a starter template's own page is opened.
<!-- verify after the template page shows seed media -->

## The live call

On the shoot screen, "Call Director" starts a voice-and-video call with Gemini Live, the
native-audio Live API on Vertex AI (`LIVE_MODEL`). The API relays it, because the Live
API on Vertex takes OAuth credentials, not an API key, and those stay on the server.

### The relay

The browser opens a WebSocket to `/api/live?videoId=…&shot=n` on the site's own origin,
with its session cookie (`apps/web/src/modules/director/lib/call-session.ts`). The API
(`apps/api/src/modules/live/live.gateway.ts`) checks the origin, the session and its
workspace exactly as any procedure does, that the plan is ready and has that shot, that
the caller has no other call open, and spends one of their 20 calls an hour. It then
opens the Live API's WebSocket in the Vertex AI region (`LIVE_LOCATION`) with an access
token for the VM's service account from the metadata server
(`apps/api/src/modules/live/google-auth.ts`), and relays both ways
(`apps/api/src/modules/live/live.relay.ts`). Every message from the browser is validated
against the schema in `packages/contracts/src/live.ts`, and anything from Gemini the
relay can't read is dropped.

### What it tells Gemini

The first message (`apps/api/src/modules/live/live.setup.ts`) sets up the call:

- answer in audio, in the prebuilt voice Sulafat;
- the persona: a warm director on a video call with someone filming for the first time,
  one instruction at a time, looking at the camera before talking about framing or
  light, praise before a fix, and silence while a take records, since the take records
  the filmer's own voice;
- the shot, described from the plan (what it is for, where, the framing, the phone's
  angle, the pose, the steps and the lines), framed as a description of what to film,
  never as instructions;
- the five tools, below;
- voice activity detection that lets the filmer interrupt (barge-in);
- transcripts of both sides;
- a sliding context window: audio with video fills the context in about two minutes,
  and sliding it keeps a ten-minute call going.

Then a first turn asks Director to say hello and give the first instruction, so it
speaks first instead of waiting in silence.

### Sound, pictures and words

| Direction | What | Format |
|---|---|---|
| browser to Gemini | the microphone | 16 kHz, 16-bit little-endian mono PCM, in chunks of about 100 ms, captured by an AudioWorklet off the main thread |
| browser to Gemini | the camera | a JPEG 640 pixels wide, about once a second (the relay drops frames sent closer together) |
| browser to Gemini | a move to another shot | the new shot's brief, as a turn in the same conversation |
| Gemini to browser | Director's voice | 24 kHz, 16-bit little-endian mono PCM, queued back to back so it plays as one stream, and cut off the moment the filmer talks over it |
| Gemini to browser | both sides' words | transcripts, shown as live captions |
| Gemini to browser | tool calls | carried out by the camera screen |

The relay also bounds what each side may send: audio at most twice real time over a few
seconds, a few typed turns and shot moves at a time, and about half a minute of audio
waiting on Gemini. Past those, or at ten minutes, the call ends and the browser hears why.

### Tools

Gemini can work the camera app with five tools, each with a short reason:

| Tool | What the camera screen does |
|---|---|
| `start_recording` | starts the take (the same as the filmer saying "action") |
| `stop_recording` | stops it ("cut") |
| `retake` | throws the take away and sets up the shot again |
| `next_shot` | keeps the take on screen and moves on, or skips ahead before a take |
| `previous_shot` | goes back a shot, only when the filmer asks |

The relay passes each call on to the browser and tells Gemini it was done
(`relayToolCalls`); the shoot screen runs it exactly as it would the filmer's own spoken
request (`useCallTools` in `apps/web/src/modules/director/pages/shoot.tsx`).

### One call, the whole Short

The call is held above the shot's own screen, so it lasts from the first shot to the
last: when the filmer moves on, the browser sends a `shot` message and Gemini gets the
new shot's brief in the same conversation, remembering what was said. A call that can't
start (no microphone, no allowance left for the hour, Gemini unavailable) or drops says
why and hands the shot back to Director Live, with the take on screen and every take
already sent untouched. The first time a call reaches Gemini, the API records a
`call_started` event in BigQuery.

## Director without a call

Without a call, Director Live directs the shot itself: Gemini 3.8 Flash
(`DIRECTOR_MODEL`) checks a camera frame every few seconds, or at once when the camera
looks somewhere new, and says where to go (`check_scene`); on-device models track the
pose and find props; and one voice says the most useful cue at a time. That voice is
Gemini's text-to-speech (`TTS_MODEL`, `apps/ai/app/speech.py`): the API keeps each line it
gets back in Cloud Storage, named by a hash of the voice and the words, so a line is
spoken once for everyone and replayed from a signed link after that. When it fails or
takes over two seconds, the browser's own speech synthesis says the line instead.
[director.md](director.md#the-screens-appsweb) describes every guide.

## Takes and the best take

A take goes straight from the browser to Cloud Storage through a signed upload URL (at
most 60 seconds and 15 MB for a video). The worker checks the stored file's type and
scans it with ClamAV before the API accepts it as a take. The API then hands the AI
service a signed read of it, valid for 30 minutes, and the `review-take` job:

1. downloads the take (refusing anything over 16 MB, so it fits Gemini's inline request
   once base64 has grown it);
2. sends Gemini 3.8 Flash the take with the shot it was meant to be, asking for the one
   continuous stretch worth keeping (as close to the shot's length as the take allows), a
   score from 0 to 100 for how closely it follows the shot, and one kind sentence of
   feedback: what worked, then the one thing to try next;
3. stores the review on the take and records a `take_reviewed` event with its score.

Takes are never replaced: a shot collects every attempt. The API's `director.shots`
(`apps/api/src/modules/director/shots.ts`) picks the best-scored take of each shot (the
newest of a tie), and a shot needs a retake while that pick scored below 60
(`DIRECTOR_RETAKE_BELOW`). A shot with no scored take yet has no pick and asks for
nothing.

## The editor

The editor (`apps/web/src/modules/director/pages/edit.tsx`) is built for someone editing
for the first time. The shots run left to right, each as wide as it is long; a shot's
takes stack beneath it with Director's pick marked, and a stepper moves to another take
(`lib/picks.ts`). A shot asking for a retake shows Director's note and a Retake button
that comes back to the editor once the new take is kept. The preview plays the picks;
captions come in a bold "pop" style, YouTube's boxed style, or none; the takes' own sound
can be left out; and every change can be undone.

"Save video" renders the cut in the browser (`lib/stitch.ts`): each picked video's best
stretch, as Gemini kept it, and each photo with a slow zoom, in the plan's order, drawn
onto a 720×1280 canvas at 30 frames a second with the captions burned in, and recorded
with the takes' sound at about 4 Mbit/s. It takes as long as the video plays and can be
cancelled. The file is uploaded and checked like a take (at most 100 MB), then
`director.saveCut` records it with the take picked for each shot.

## My media

`/media` lists the member's saved videos, grouped under the template each was made from,
to play from a signed link, each with its YouTube publish status.

## Publishing to YouTube Shorts

<!-- verify after publish merges -->

Publishing starts from a saved video in My media and uploads only when the member taps.

- **The post.** Gemini 3.8 Flash drafts the title, description, hashtags and credits for
  the video from its plan and the original's title and channel (the AI service's
  `apps/ai/app/publish_copy.py`). The credits name the original creator and link the
  original Short. The member sees every field in the publish sheet
  (`apps/web/src/modules/director/components/publish-sheet.tsx`), edits any of them, and
  picks the visibility: unlisted by default, or private or public.
- **Permission.** Google sign-in asks only for the basic profile. The first publish
  answers `PUBLISH_NEEDS_YOUTUBE`, and the web app asks Google for the `youtube.upload`
  scope (incremental consent) and tries again.
- **The upload.** The API streams the video from Cloud Storage to YouTube's resumable
  upload with the member's own Google access token, refreshed when it expires
  (`apps/api/src/modules/publish/youtube-upload.ts`). The title gets `#Shorts`, the
  description ends with the hashtags, the credits and the original's link, and the video
  is never marked as made for kids. The video's publish status goes from uploading to
  published, with its YouTube id and the privacy YouTube actually gave it (an unverified
  app's uploads may be made private), or to failed. A `published` event goes to BigQuery.
- **Refusals.** Nothing reaches YouTube from the demo account (`PUBLISH_DEMO_DISABLED`)
  or for a video whose file isn't checked or is gone (`PUBLISH_CUT_NOT_READY`).
- **The day's allowance.** Each upload costs a large share of the project's daily
  YouTube Data API quota, which indexing's reads draw on too, so Director publishes at
  most `PUBLISH_DAILY_LIMIT` (5) videos a day across every member, the day being
  YouTube's own quota day: midnight to midnight Pacific time, daylight saving included
  (`apps/api/src/modules/publish/quota-day.ts`). The count is a Redis key per Pacific
  date that expires when that day ends (`daily-allowance.ts`). A place is taken just
  before the video is claimed for upload and given back only if YouTube never opened
  the upload session: once it has, the insert counts against the quota whatever happens
  next. Past the allowance, or when YouTube says the project's quota or rate is spent,
  the member sees `PUBLISH_QUOTA_EXHAUSTED`.

## Product analytics

The API and the AI worker stream one row per event into one BigQuery table
(`BIGQUERY_DATASET`'s `events`, `director.events` in production), with the VM's service
account: `indexed` (with the model that wrote the plan and whether its audio was
captured), `take_reviewed` (with the score) and `call_started`. Each is recorded only once
the thing has happened (a stored plan, a stored score, a call Gemini answered), and a
slow or failing BigQuery never holds up the action that triggered it
(`packages/nest-common/src/analytics.ts`, `apps/ai/app/analytics.py`).
