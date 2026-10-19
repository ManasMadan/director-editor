# Director

Director teaches someone to film their own version of a YouTube short. They pick a template
from the library (the six seed Shorts every workspace starts with, or one Short of their
own they paste a link to), Gemini watches it and writes the shot plan (how many shots,
which are videos and which photos, in what order, where to stand, how to hold the phone,
what to say), and Director (Gemini Live) talks the member through each shot on the shoot
screen. Gemini then reviews each take and picks its best part, and the browser stitches
the takes into the finished short. This page covers the screens, the shoot screen, the
data and the demo; [how-it-works.md](how-it-works.md) follows each step underneath
(indexing, Director live, reviews, the editor, publishing).

```
apps/web (library, camera)    ──@repo/client──▶  apps/api  ──ai-client (JWT)──▶  apps/ai  ──▶  Gemini
  │ getUserMedia, MediaRecorder,                 │ shorts: YouTube link check       │ plan job: watches the short by URL
  │ Director live (/api/live WebSocket),         │ director: checks, then proxies    │ review job: watches one take
  │ canvas stitching                             │ live: relays to Gemini Live       │
  └── presigned PUT ──▶ storage ──▶ apps/worker (ClamAV, type check) ─────────────────┘
```

## Turning it on

Director calls the real Gemini and YouTube Data API v3, like the rest of the app; there
is no local stand-in for either in `bun dev` or `bun dev:full` (the **mock Google**,
`packages/fake-google`, speaks both protocols, but only integration, e2e and fuzz suites
start it, never the running app). `.env.example` ships every Google variable empty, so
Director stays off until you set real keys:

```sh
bun run setup                              # once: .env from .env.example
bun run env:set S3_BUCKET=uploads          # takes are uploads
bun run env:set YOUTUBE_API_KEY=...        # a YouTube Data API v3 key
bun run env:set GOOGLE_API_KEY=...         # a Vertex key, or a Gemini API key (below)
bun run env:set GOOGLE_CLOUD_PROJECT=...   # the Vertex project; also turns on Director live
bun run env:set DIRECTOR_MODEL=gemini-3.8-flash
bun dev:full                               # the AI service, RustFS and ClamAV too
```

Then sign in (`bun run db:seed` makes `demo@example.com`) and open
http://localhost:3000/library.

Director is on when the API has `YOUTUBE_API_KEY` and the `ai` and `files` features, and
the AI service has `DIRECTOR_MODEL` and `GOOGLE_API_KEY`
([environment.md](environment.md)). `.env.example` defaults `GOOGLE_VERTEX` to `true`,
so a `GOOGLE_API_KEY` you add is addressed through
Vertex AI rather than the Gemini API, once `GOOGLE_CLOUD_PROJECT` is also set (below,
under Director live): `GOOGLE_API_KEY` then needs to be a Vertex key bound
to a service account, and usage bills through Cloud Billing rather than the Gemini API.
Unset `GOOGLE_VERTEX` to call the Gemini API directly instead. Production refuses a
plain-HTTP `GOOGLE_BASE_URL` or `YOUTUBE_API_URL` (the mock Google's protocol, not a real
endpoint). A plan job (watching a short unattended) indexes it with `INDEX_MODEL`, a
separate, more thorough model from `DIRECTOR_MODEL`'s live locates and reviews;
`INDEX_FALLBACK_MODEL` is tried once after `INDEX_MODEL`'s own retries on a transient
failure are spent. The plan's `stage` says how far it got, stored and announced as each
is reached: `queued` when it's asked for, `watching` while Gemini watches the short,
`writing` once Gemini has answered (the original audio is captured into `MEDIA_BUCKET`
and the plan saved), then `ready`, or `failed` with its reason:
`DIRECTOR_VIDEO_UNAVAILABLE` when Gemini can't watch the video (private, removed,
age-restricted), `DIRECTOR_ANALYSIS_FAILED` otherwise. A failed plan never counts as the
member's one short of their own. With `INDEXER_URL` set, the indexing runs on the Cloud
Run indexer instead of in the worker ([deploy.md](deploy.md#the-cloud-run-indexer)).

Integration, e2e and fuzz suites never need a real key: they start the mock Google
themselves (`startFakeGoogle` from `packages/fake-google`, e.g.
`apps/web/test/global-setup.ts`), which answers YouTube's video reads for six real public YouTube
videos (their pictures and the embedded player are YouTube's own, the answers are mock
data): the first, "GRWM for the office in summer time!", is the short the demo recreates
(`packages/fake-google/src/catalog.ts`, `plans.ts`), the other five stand in for shorts,
and any pasted link opens too. Its locates and take reviews are in
`packages/fake-google/src/gemini.ts`.

## The screens (apps/web)

| Route | What it is |
|---|---|
| `/library` | the workspace's templates (starters and members' own, each with its shot rhythm and length, or its indexing stage), and "Bring your own Short": paste a link and Gemini indexes it, live; a second one of your own opens the "You've used your AI credit" dialog |
| `/shorts/[videoId]` | an old link: redirects to `/director/[videoId]` |
| `/director/[videoId]` | the template: the original, its storyboard, each shot's scene, framing, phone angle and lines, what you've filmed, the audio choice, Let's shoot |
| `/director/[videoId]/shoot?shot=n&audio=voice\|original` | the shoot screen, on shot n; with `&back=edit` (a retake asked for in the editor) it goes back to the editor once the take is kept |
| `/director/[videoId]/edit?audio=voice\|original` | the editor: a board of shots left to right (each as wide as it is long), each shot's takes top to bottom with Director's pick marked, a stepper to change the pick, Director's note and a Retake on a shot whose best take scored below 60; the preview plays the picks; "Save video" renders the cut in the browser (about 720×1280 at 4 Mbit/s, at most 100 MB), uploads it and saves it to My media, with Cancel while it does |
| `/media` | My media: the member's saved videos, under the template each was made from, to play, with each one's YouTube publish status |

The shoot screen is one screen for the whole short. The camera fills it (a 9:16 column
on a laptop), with a top band (the shots, Director, the way out) and a bottom band
(Director's captions, a text box, flip and the shutter).

- **Start shooting.** Nothing turns on until the member taps Start shooting. The card
  above it says what happens: Director sees and hears them while they get set, and a
  take records only on the shutter. The first time it also says the browser will ask
  for the camera and microphone next. The tap opens the selfie camera and brings
  Director in, and also lets the page make sound.
- **Director live** (`hooks/use-director-live.ts`, `lib/live-session.ts`): Gemini Live
  through the API's relay ([how-it-works.md](how-it-works.md)). The microphone and a
  frame a second go up; Director's voice comes back, and both sides are captioned
  (`components/director-captions.tsx`), so the shoot can be followed with the sound off.
  The captions keep their own store (`lib/caption-store.ts`), so a transcript chunk
  re-renders only them, and Director's words show as its queued voice reaches them
  (`lib/voice-clock.ts`, an even speaking pace from the turn's first sound): words it
  never got to say before the member cut in never show, and its line ends when its voice
  does. Gemini's transcript can still trail the voice at a turn's start; how far shows
  in the relay's "live turn" log (`captionLagMs`) and on the phone in
  `directorLiveTimings()` (`lib/live-debug.ts`, from the remote inspector's console).
  The captions show the last exchange oldest first, so a reply sits under what it
  answers; the member's line goes eight seconds after Director has answered it, or at
  once on a flip, a countdown or a take review. Screen readers hear each line once it's
  finished. The relay holds the app's own notes (a move to another shot, a flip, a
  nudge) until Director's turn ends (`live.gate.ts` in apps/api), because any of them
  would stop Director mid-sentence; and right after Director changes the plan, the
  screen moves to another shot only once the member asks (`lib/move-guard.ts`). What the member types in the text box goes to Director as their own words,
  on the take review too. Director talks like a friend helping shoot a reel: it answers
  everything, reads the line back when asked, goes with the member's own wording, and
  nudges once (twice at most) after fifteen quiet seconds. Director
  can show another shot (`go_to_shot`), flip the camera (`switch_camera`) or change a
  shot to the member's own idea (`adapt_shot`: "what if I do it with my grandma"), or put
  a labelled box on something it can see (`point_at`: "your window"), or rate an
  attempt and make the member's pick their choice (`rate`), never
  start or stop a take; the screen answers each request with what really happened
  (done, or refused because a take is under way or the camera is off). A changed shot
  shows the member's version on the card (`lib/your-version.ts`), its changed rows
  saying "changed for you", and the teleprompter and the take review use their line. The camera, the
  microphone and Director stay up from shot to shot: moving on changes only what the
  screen shows.
- **The roll** (`lib/roll.ts`, `hooks/use-roll.ts`, `hooks/use-roll-shoot.ts`): with
  Director on, Start shooting starts one continuous recording, chat included, until Done.
  The recorder hands over a ten-second slice at a time to the uploader
  (`useSliceUploader` in packages/client), which keeps it in IndexedDB until it's stored,
  so a closed tab loses at most the slice in progress and the next visit sends the rest.
  A flip starts a new part. Director marks each attempt (`mark`, start and end), stamped
  with the recording's own clock, and the server cuts every marked attempt into a take.
  The top band shows "REC" and the time with pause beside it, and a progress strip (a
  take, tried, to do) whose shots can be tapped. Pausing (the button, the tab hidden, or
  five minutes of footage waiting to upload) stops the recording and what Director sees
  and hears, greys the picture, and only Resume or Space starts it again. Done stands
  where the shutter was, and the editor opens once the footage is uploaded.
- **The shutter** (`hooks/use-studio.ts`) is the baseline when the roll can't run
  (Director off, or a browser that can't record): a tap counts
  down 3, 2, 1 (a second tap, or Escape, calls it off), then records until it's tapped
  again or a moment past the shot's length. Director is told when the count starts (and
  when it's called off), and its voice is held from the first number to the take's end,
  so it never talks over the count or ends up in the take; what it says while held is
  never shown either. While a take records, a red "REC" and its time show, and the line
  to say stays on screen (the teleprompter). Then the
  take loops to watch back, with Director's word on it, to go again or keep. Keeping it
  uploads it and moves to the next shot (or the editor after the last).
- **Leaving.** ✕ (or the browser's back) leaves at once in setup. During a countdown,
  a recording or with a take not kept yet, it asks first ("Leave? This take isn't kept
  yet.", `hooks/use-leave-guard.ts`): the count is called off or the recording stopped
  at once, so Stay keeps the take on screen.
- **Flip.** The flip button swaps between the selfie and the back camera. Director is
  told once the other camera's picture is up, so it talks about the new view.
- **When Director can't be there.** A dropped line or Gemini out of reach is retried
  once, silently, after two seconds. If that fails too (or Director is off on the site,
  or the hour's allowance is spent), the top band says why, says the shutter still
  works, and offers Try again where it could help. Without a microphone Director still
  sees, speaks and reads the text box.
- **It remembers** (`lib/memory.ts`): how many shoots the member has started, so the
  card says less after the first.
- **The wrap.** Keeping the last shot opens the editor on Director's cut of the takes,
  playing, with "That's a wrap!", for any last changes.
- The screen is kept awake while it's open (Wake Lock).

The seam, documented in its file:

| Concern | Now | Later | Where |
|---|---|---|---|
| What Director remembers | this browser's storage | an API procedure, a row per member | `MemoryStore` in `apps/web/src/modules/director/lib/memory.ts` |

With "use the original audio", the take records no sound and the original plays while
filming, in YouTube's own embedded player; the finished short is silent, for the original
sound to be added when posting on YouTube ("Use this sound"). Director never downloads a
YouTube video's picture: indexing captures only its audio track
([how-it-works.md](how-it-works.md#the-originals-audio)), which a plan links as
`audio.url`.

A plan also lists what a Short needs beyond the member filming themselves: its `assets`
(a chart under the speaker, a headline card, an end card, B-roll, music), each with a
reference describing the original's piece precisely enough to make a fresh one and the
prompt to make it from, and its `edits` (a split screen, captions, a grade, overlays,
transitions, speed, an end card, gaps for B-roll), timed in the original's seconds. A
shot's `mode` says what the edit uses of its take: the member `on-camera`, only their
voice (`voice-over`, a video take), or nothing (`asset`, a photo take standing in until
the editor places the asset). Right after a plan is saved, the worker draws a default
image for each still among its assets with Nano Banana (`ASSET_MODEL`, the `assets` job,
`apps/ai/app/assets.py`): at most 5 a plan and 30 a day per member (`ai.images_today`,
counted under a per-member lock), each counted in `ai.usage`, kept in `MEDIA_BUCKET`
under the plan, and linked on the template's own page (`director.plan`) as each asset's
`image`. The original's branding (the brands the planner lists, handles, web addresses)
never reaches a default image or an edit's words: a neutral placeholder ("Your Name")
stands there instead (`apps/ai/app/branding.py`). A seeded template's images come with
its media (`seeds:assets`, then `seeds:media`).

## Phones

`getUserMedia` and DeviceOrientation need a secure context: `http://localhost` on the
computer itself, or HTTPS. To try it on a phone on the same Wi-Fi, run the web app over
HTTPS (`next dev --experimental-https`, or a tunnel) and open it by the computer's address.
iOS asks before a page may read the tilt: the level shows a button for that.

## Where things are

- Data: `ai.director_plan` (one per workspace and video, shared by its members: the
  workspace's library of templates, the seeded ones and the one short each member may
  index across all their workspaces, held by the partial unique index
  `director_plan_one_user_index` and read through `ai.index_used`),
  `ai.director_take` (each member's own; never replaced, the best-scored is picked),
  `ai.director_cut` (a member's rendered video of a plan and how far publishing it got),
  `ai.director_asset` (the default image of each still a plan's assets name, and how far
  drawing it got),
  `app.short_reaction` (the removed feed's likes and saves: nothing reads it, and a
  later migration drops it), and the continuous recording's `app.recording_session`,
  `recording_part`, `recording_slice`, `recording_attempt` and `recording_pause`
  ([how-it-works.md](how-it-works.md#continuous-recording)); all under row-level security. Plans are a JSON
  column validated by `ShotPlan` on the way in and out.
- AI service: `apps/ai/app/director.py` (the three Gemini calls, their token budgets and
  failures), queues `ai-director` (`plan`, `assets`, `session-pass`) and `ai-review` (`review-take`)
  in `packages/jobs`.
- Seed templates: `packages/contracts/src/director-seeds.json`, the 6 seed Shorts
  (`apps/ai/app/seeds/seeds.json`) indexed for real on Vertex AI and committed. Rebuild it
  with `bun run --filter @repo/ai seeds:build` whenever the plan schema changes (and check
  indexing still works on Shorts beyond the seeds with `bun run --filter @repo/ai
  evals:index`, `apps/ai/evals/`). It sits in
  `packages/contracts` because the AI service writes it and the API reads it (services never
  import each other); `src/director-seeds.ts` parses it against the plan's contract when the
  API loads. Every workspace gets its own copy of the 6 the moment it's created
  (`apps/api/src/modules/director/seeds.repository.ts`, in the same transaction as the
  workspace): rows with `source = 'seed'`, ready, in nobody's name, so they never count as
  anyone's one index. Workspaces made before that get theirs from
  `bun run --filter @repo/api director:seed-workspaces` (deployed: `node
  dist/director-seed-workspaces.mjs` in the api image), which adds only what's missing and
  is safe to run again.
- API: `apps/api/src/modules/shorts` (whether a pasted link is a Short Director can film:
  `youtube.ts` is the only code that knows YouTube's wire format),
  `apps/api/src/modules/director` (checks, then the AI service).
- Contracts: `packages/contracts/src/api/director.ts`; the plan's shape is checked
  against the Python model by `apps/api/src/modules/director/limits.test.ts`.
- Web: `apps/web/src/modules/director` (the library, the template, the camera and the
  editor; `lib/` holds the
  pure parts: tilt, pose, framing, timeline, doodles, the edit, the stitcher).

## The demo

Anyone can try Director without signing up: the landing page's "Try it now, no sign-up"
opens `/sign-in?demo=1`, which signs the browser straight in to the demo and goes on to
the library (or to the template the visitor tapped, through `next=`). The sign-in page
also shows a demo card. Which demo it is depends on the API's configuration
([environment.md](environment.md)), and the page learns it from `system.info`.

### Demo guests

With `DEMO_GUESTS=on` (production), each browser gets a private guest of its own
(`apps/api/src/auth/guest.ts`), so judges never see each other's takes, videos or
chatter. The card reads "Just looking? Use the demo. Your footage is deleted after a day,
and posting to YouTube is off."

- A guest is an ordinary user, made through better-auth's adapter by
  `POST /api/auth/sign-in/guest`, so the sign-up hooks give it a personal workspace with
  the seeded templates. Its address is on the reserved `guest.invalid` domain (nothing is
  ever mailed to it), and its name is "Guest" in its own language. It may index one Short
  of its own, like anyone.
- It's flagged `demo`, so everything the shared account can't do below, a guest can't
  either: publish (My media shows the post Director wrote, to read: "See the post Director
  wrote"), or change, lock or link anything to its account.
- `auth.user.guest_until` is when it's deleted: a day after it was made
  (`DEMO_GUEST_LIFETIME_S`). Its session ends then too, whatever cookies the browser sends:
  a database hook clamps any new session expiry to `guest_until`, so a refresh can't
  stretch it, and the session's copy in Valkey expires with it.
- The worker's hourly `demo-retention` task calls `auth.purge_expired_guests()`, which
  deletes each expired guest with the workspaces only it belongs to (their plans, takes,
  cuts and AI usage cascade from the workspace, its files and sessions from the user). It
  first adds the guests' AI usage to `ai.demo_usage` (by month, feature and model), so the
  demo's cost stays on record. The worker then deletes the guests' session keys from
  Valkey and runs the files cleanup, so the deleted files' objects leave storage in the
  same run.
- A guest gets less than a member: `AI_MONTHLY_TOKENS_PER_DEMO_GUEST` tokens a month (the
  AI service asks `ai.demo_guest_workspace()`) and `DEMO_GUEST_LIVE_CALLS_PER_HOUR` live
  calls an hour.
- A browser already signed in (a guest within its day, or a member) gets no new guest.
- Abuse limits:
  - Turnstile on the guest sign-in while captcha is on. The widget is invisible unless
    Cloudflare wants an interaction, so it's still one tap.
  - `DEMO_GUESTS_PER_ADDRESS` guests an hour from one client IP (better-auth's rate
    limiter, 429).
  - `DEMO_GUEST_LIMIT` guests at once in all (`DEMO_GUESTS_FULL`). The live guests are a
    sorted set in Valkey, checked and added to in one script, so a burst of sign-ins
    can't overshoot the cap.
- When no guest can be made, the sign-in page says so and offers the shared demo account
  below, filled in the form, with a line saying that others see what's filmed in it.
  Without a shared account it says why (the demo is full, or too many tries) and the
  card's button tries again.

### The shared demo account

The fallback with guests on, and the whole demo with them off: one account,
`demo@director.mmadan.in`, whose email and password the sign-in page shows, with a "Use
demo account" button that fills the form (`?demo=1` fills it at once when guests are off).
The page gets both from `system.info`, and only when the API has `DEMO_PASSWORD` set.

The account itself is made by a command, once per environment and again whenever the
password changes:

```sh
bun run --filter @repo/api director:demo-account --force   # locally
node dist/director-demo-account.mjs                        # deployed, in the api image
```

Outside production it refuses without `--force`. It makes the account verified, with the
password `DEMO_PASSWORD`, `demo` set on its user row (`auth.user.demo`) and the seeded
templates in its personal workspace. Run again, it only sets the password and the flag back
and copies any seed the library is missing: what judges did with the account (its own
indexed Short, takes and cuts) stays. `--reset` starts over: it deletes the account and the
workspaces only it belongs to, and everything made in them, then makes it again with only
the seeds. It doesn't check the password against public breaches, even with
`PASSWORD_BREACH_CHECK` on: the sign-in page shows it to everyone anyway, so the check
would protect nothing, and the command never depends on Have I Been Pwned being up.

Everyone shares the account, so (`apps/api/src/auth/demo.ts`, and the same for guests):

- it can't publish: publishing refuses a session whose `session.user.demo` is true with
  `PUBLISH_DEMO_DISABLED`; drafting the post still works, for My media to show it;
- it can't change, lock or empty the account or its workspace: changing the password,
  deleting the account, turning on two-step verification, linking a Google account or a
  passkey, ending sessions, renaming itself or changing its picture, and making,
  renaming, leaving or deleting a workspace answer `DEMO_ACCOUNT_LOCKED` (its email and a
  password reset need codes sent to its address). It can still set its own language and
  time zone;
- it keeps nothing of a visitor's as its own, which the next visitor would see: it
  can't record (`recording.start`), add, draw or pick an image for a template's assets,
  describe a template of its own (`director.brainstorm`, `create`, `editPlan`), or keep
  or re-plan its version of a template (`yourVersion.save`, `revise`, and so what
  Director remembers of it). Those answer `DEMO_ACCOUNT_LOCKED` (the `inPrivateOrg`
  builder in `apps/api/src/rpc/procedures.ts`); a demo guest, whose workspace is its own,
  can do all of them;
- its device list shows only the device asking, never the others signed in to it;
- while `DEMO_PASSWORD` is set, its sign-in has no per-account attempt limit, since its
  password is public; the per-address limit still applies.

Nobody can delete a personal workspace through the API, the demo's or anyone's: it goes
with its account. Running the command again also puts back the account's and its
workspace's names.

It indexes a Short of its own like any account (one).

Its footage lasts a day too, like a guest's: the worker's `demo-retention` task calls
`files.purge_demo_footage()`, which deletes what the account kept that's older than a
day: its takes and videos, brief photos and asset uploads (their files, and the takes
and cuts with them), the images it drew, uploaded or picked for a template's assets, the
templates it described, and its versions of templates. The files cleanup removes their
objects from storage. Its library (the seeds and its own Short) stays.

## Limits

- A take is at most 60 seconds and 15 MB, so it stays under the 20 MB Gemini takes inline
  in one request once base64 has grown it; the recorder aims at 1.5 Mbit/s.
- YouTube's free quota is 10,000 units a day; checking a link costs 1, and each video's
  answer is cached for an hour.
- Token caps per plan, locate and review come out of the workspace's monthly AI
  allowance (`AI_MONTHLY_TOKENS_PER_ORG`).
- Stitching happens in the browser and takes as long as the short plays.

## Trying it in a browser

`playwright-cli` drives Chrome with its fake camera and microphone (a test pattern and a
tone), so the whole flow, recording included, runs without a webcam: open it with a
config whose `launchOptions` has `"channel": "chrome"` and the args
`--use-fake-ui-for-media-stream` and `--use-fake-device-for-media-stream`, and whose
`contextOptions.permissions` grants `camera` and `microphone`.
