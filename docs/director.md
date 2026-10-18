# Director

Director teaches someone to film their own version of a YouTube short. They pick a template
from the library (the six seed Shorts every workspace starts with, or one Short of their
own they paste a link to), Gemini watches it and writes the shot plan (how many shots,
which are videos and which photos, in what order, where to stand, how to hold the phone,
what to say), and the camera screen guides each take live. Gemini then reviews each take
and picks its best part, and the browser stitches the takes into the finished short.

```
apps/web (library, camera)    ──@repo/client──▶  apps/api  ──ai-client (JWT)──▶  apps/ai  ──▶  Gemini
  │ getUserMedia, MediaRecorder,                 │ shorts: YouTube link check       │ plan job: watches the short by URL
  │ DeviceOrientation, MediaPipe pose,           │ director: checks, then proxies    │ scene check: one camera frame
  │ speech synthesis, canvas stitching           │ files: take uploads, signed reads │ review job: watches one take
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
bun run env:set GOOGLE_API_KEY=...         # a Gemini API key, or a Vertex key (below)
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
under Director's live video call): `GOOGLE_API_KEY` then needs to be a Vertex key bound
to a service account, and usage bills through Cloud Billing rather than the Gemini API.
Unset `GOOGLE_VERTEX` to call the Gemini API directly instead. Production refuses a
plain-HTTP `GOOGLE_BASE_URL` or `YOUTUBE_API_URL` (the mock Google's protocol, not a real
endpoint). A plan job (watching a short unattended) indexes it with `INDEX_MODEL`, a
separate, more thorough model from `DIRECTOR_MODEL`'s live scene checks and reviews;
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
and any pasted link opens too. Its scene checks and take reviews are in
`packages/fake-google/src/gemini.ts`.

## The screens (apps/web)

| Route | What it is |
|---|---|
| `/library` | the workspace's templates (starters and members' own, each with its shot rhythm and length, or its indexing stage), and "Bring your own Short": paste a link and Gemini indexes it, live; a second one of your own opens the "You've used your AI credit" dialog |
| `/shorts/[videoId]` | an old link: redirects to `/director/[videoId]` |
| `/director/[videoId]` | the template: the original, its storyboard, each shot's scene, framing, phone angle and lines, what you've filmed, the audio choice, Start shooting |
| `/director/[videoId]/shoot?shot=n&audio=voice\|original` | the camera, one shot at a time |
| `/director/[videoId]/review` | every shot's newest take and its review; "Make my short" stitches and downloads |

The camera screen is **Director Live**: the camera in a floating capsule over a blurred,
dark copy of itself, an aurora behind it that breathes while Director talks or listens, a
frosted dock (show your screen, talk, the shutter, pause, end) and a few status pills.
Controls fade after a few seconds untouched; any touch brings them back.

- **One voice.** Everything that could say something (Gemini's scene check, the phone's
  own light and shake readings, the framing, the angle, the pose, what's in the frame,
  the steps) offers a cue to `lib/cues.ts`, which picks the one that matters most, waits
  a breath between lines, never repeats a line inside its cooldown, and gives the member
  the floor when they talk. The line is shown as a caption and, with the voice on, said
  aloud. It talks to someone filming for the first time, a grandparent or a child: warm,
  short, one thing at a time, and patient (a breath of 4.5 seconds between lines, 25
  before a nudge comes back). A few calls punctuate it: "Get ready! Here we go in 3",
  "Action!", "Cut!", "Let's try that one more time", "That's a wrap".
- **Reacts as the camera moves.** The phone samples a tiny copy of the frame four times
  a second (`lib/frame-stats.ts`): light, backlight and shake answer at once, and a
  frame that looks somewhere new asks Gemini for a scene check straight away instead of
  waiting for the next one.
- **Points things out.** MediaPipe's object detector (EfficientDet-Lite0, in the browser)
  finds props, backdrops, pets and screens (`lib/things.ts`); the best few get a lasso
  and a name, and Director says what they're good for. The shot's landmark comes first.
- **Doodles, not boxes** (`lib/sketch.ts`, `lib/doodle.ts`): single pen lines with a
  soft shadow, boiling like hand-drawn animation, few at a time. A stick buddy strikes
  the pose to copy, breathing and blinking, and its face says how the set-up is going
  before Director does: a smile, a "?" while it can't see you, a worried look with a
  little sun when the light needs fixing, a grin and a hop once you match it (faded back
  while recording). Footprints mark where to stand, beside a lassoed landmark; arrows
  say which way to go. One thing at a time: while Gemini walks you to your spot, the walk
  is all that's drawn, and the buddy comes once you're there (or once Gemini can't guide
  any more: out of reach, or its checks spent). Then a horizon to level, and stickers
  when it comes together (a star when
  the pose locks, "Nailed it!" when the ready check is all green, the clapperboard for
  each take). Everything tracked glides on a critically damped spring
  (`lib/spring.ts`), so nothing jitters. Reduced motion stops the boil, the bob and the
  blink.
- **The ready check**: spot, frame, angle, light, each green, amber, or left out when the
  shot or device can't judge it (`lib/readiness.ts`).
- **Talk to it.** The browser's speech recogniser listens (Chrome, Safari): "action",
  "cut", "go again", "keep it", "flip", "repeat", "quiet", in the member's language
  (`director.live.voice.words`). Talking over Director stops it. What the microphone
  hears of Director's own voice, and phrases the recogniser doubts, are ignored
  (`lib/intents.ts`). It stops listening while a take records the member's voice.
- **Hands-free.** Hold a hand above your head for a moment to roll.
- **Flip and share.** The flip button swaps cameras; the dock can show Director the
  screen instead (no recording then), and Director brainstorms from the shot's plan.
- **The Director's Cut.** The moment a take ends, `lib/cut.ts` picks its steadiest
  stretch of the shot's length to loop, scores it, and gives one piece of praise and one
  thing to try (energy from the voice's level, shake, light, framing, a late start),
  said aloud a beat after "Cut!". Gemini's full review follows once the take is kept.
- **It remembers** (`lib/memory.ts`): voice and listening on or off, the countdown
  (or, on Auto, a longer one once most takes start late), the light problems and props
  that keep coming up, sessions and scores. The greeting is about last time.
- **The wrap.** Keeping the last shot opens the editor on Director's cut of the takes,
  playing, with "That's a wrap!", for any last changes.
- **Never stuck.** Two failed scene checks in a row (no allowance, rate-limited, Gemini
  down) switch Director to on-device guidance for the shot, with an "On-device" badge;
  a detector that can't load just leaves its guide out.
- **Phone angle**: a horizon doodle from the phone's tilt (DeviceOrientation), solid green
  inside the plan's tolerance. A computer has no tilt sensor, so the angle check is left
  out there. The screen is kept awake while it's open (Wake Lock), and phones buzz on the
  beats (Vibration).

The seams, each documented in its file:

| Concern | Now | Later | Where |
|---|---|---|---|
| What Director remembers | this browser's storage | an API procedure, a row per member | `MemoryStore` in `apps/web/src/modules/director/lib/memory.ts` |
| Director's voice | the browser's speech synthesis | a streamed voice (Gemini Live's native audio) | `say`, `hush`, `saying` in `lib/speech.ts` |
| Hearing the member | the browser's speech recogniser | a streamed transcript from the same live session | `useListening` in `hooks/use-listening.ts` |
| Looking at the scene | a Gemini call per frame (`checkScene`) | a live session streaming frames | `useSceneGuide` in `hooks/use-scene-guide.ts` |

With "use the original audio", the take records no sound and the original plays while
filming; the finished short is silent, for the original sound to be added when posting
on YouTube ("Use this sound"). Director never downloads a YouTube video.

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
  `app.short_reaction` (the removed feed's likes and saves: nothing reads it, and a
  later migration drops it); all under row-level security. Plans are a JSON
  column validated by `ShotPlan` on the way in and out.
- AI service: `apps/ai/app/director.py` (the three Gemini calls, their token budgets and
  failures), queue `ai-director` (`plan`, `review-take`) in `packages/jobs`.
- Seed templates: `packages/contracts/src/director-seeds.json`, the 6 seed Shorts
  (`apps/ai/app/seeds/seeds.json`) indexed for real on Vertex AI and committed. Rebuild it
  with `bun run --filter @repo/ai seeds:build` whenever the plan schema changes. It sits in
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

## Limits

- A take is at most 60 seconds and 15 MB, so it stays under the 20 MB Gemini takes inline
  in one request once base64 has grown it; the recorder aims at 1.5 Mbit/s.
- YouTube's free quota is 10,000 units a day; checking a link costs 1, and each video's
  answer is cached for an hour.
- Token caps per plan, scene check and review come out of the workspace's monthly AI
  allowance (`AI_MONTHLY_TOKENS_PER_ORG`).
- Stitching happens in the browser and takes as long as the short plays.
- A camera left on the setup screen asks Gemini where to go at most twelve times a shot,
  and stops once it says you're in place.

## Trying it in a browser

`playwright-cli` drives Chrome with its fake camera and microphone (a test pattern and a
tone), so the whole flow, recording included, runs without a webcam: open it with a
config whose `launchOptions` has `"channel": "chrome"` and the args
`--use-fake-ui-for-media-stream` and `--use-fake-device-for-media-stream`, and whose
`contextOptions.permissions` grants `camera` and `microphone`.
