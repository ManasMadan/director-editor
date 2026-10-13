# Director

Director teaches someone to film their own version of a YouTube short. They pick a short
in a YouTube-style feed, Gemini watches it and writes the shot plan (how many shots,
which are videos and which photos, in what order, where to stand, how to hold the phone,
what to say), and the camera screen guides each take live. Gemini then reviews each take
and picks its best part, and the browser stitches the takes into the finished short.

```
apps/web (Shorts UI, camera)  ──@repo/client──▶  apps/api  ──ai-client (JWT)──▶  apps/ai  ──▶  Gemini
  │ getUserMedia, MediaRecorder,                 │ shorts: YouTube Data API v3      │ plan job: watches the short by URL
  │ DeviceOrientation, MediaPipe pose,           │ director: checks, then proxies    │ scene check: one camera frame
  │ speech synthesis, canvas stitching           │ files: take uploads, signed reads │ review job: watches one take
  └── presigned PUT ──▶ storage ──▶ apps/worker (ClamAV, type check) ─────────────────┘
```

## Turning it on

Locally Director runs against the **mock Google** (`packages/fake-google`): one server on
`GOOGLE_FAKE_PORT` that speaks the Gemini API and YouTube Data API v3. Every request the
app makes is real (the AI service's Gemini client, the API's YouTube client, uploads,
ClamAV, the worker); only the answers are mock data. `.env.example` points at it with
mock keys, so nothing needs a real key and nothing leaves the machine:

```sh
bun run setup                       # once: .env from .env.example
bun run env:set S3_BUCKET=uploads   # takes are uploads
bun dev:full                        # the AI service, RustFS, ClamAV and the mock Google too
```

Then sign in (`bun run db:seed` makes `demo@example.com`) and open
http://localhost:3000/home. What the mock answers:

- the feed: six real public YouTube videos standing in for shorts (their pictures and the
  embedded player are YouTube's own); any pasted link opens too;
- the plans: the PRD's examples, a GRWM in six shots (four videos, two photos) with a
  script, the pen-drop shoe flaunt in one back-camera video, and a "stand near a tree" talk;
- scene checks: two directions toward the shot's landmark, then "in place";
- take reviews: the shot's length from just after the take starts, a score and feedback.

Director is on when the API has `YOUTUBE_API_KEY` and the `ai` and `files` features, and
the AI service has `DIRECTOR_MODEL` and `GOOGLE_API_KEY` ([environment.md](environment.md)).
For the real APIs: empty `GOOGLE_BASE_URL`, set `YOUTUBE_API_URL` back to Google's, set
real keys and a real `DIRECTOR_MODEL` (`gemini-3.5-flash`). Production refuses the mock
(both URLs must be HTTPS there).

If the Expo app's bundler won't start (`bun dev:full` stops with it), run the rest with
`bunx turbo run dev --filter='!@repo/mobile'`.

## The screens (apps/web)

| Route | What it is |
|---|---|
| `/home` | YouTube's home: topic chips, a grid of real shorts (YouTube search, cached), a box to paste any Shorts link |
| `/shorts/[videoId]` | the vertical player: swipe for the next; like, comments, share, save and the Director button |
| `/saved` | the member's liked and saved shorts |
| `/director/[videoId]` | the plan: "You need 6 shots: 4 videos and 2 photos", the order, speak-or-original-audio, Record |
| `/director/[videoId]/shoot?shot=n&audio=voice\|original` | the camera, one shot at a time |
| `/director/[videoId]/review` | every shot's newest take and its review; "Make my short" stitches and downloads |

On the camera screen:

- **Script**: the teleprompter lights the line to say and sweeps it in time with the take.
- **Framing**: the shot's subject box and a stick figure are drawn on the viewfinder; with a
  person in the shot, MediaPipe's pose landmarker (in the browser) finds them and the hint
  says to step left or right, closer or back.
- **Scene**: "Stand near a tree", spoken and written. Every five seconds before recording,
  one frame goes to Gemini, which answers with a direction ("Move about five meters left,
  to the tree") and where the landmark is, drawn as a doodle around it.
- **Phone angle**: a bubble level from the phone's tilt (DeviceOrientation), solid green
  inside the plan's tolerance. A computer has no tilt sensor; it says so.
- **Pose**: the target body is drawn in amber and turns green when the member's matches it
  (the joints' shape, wherever they stand and however large).
- **Voice**: directions are read out with the browser's speech synthesis, except while the
  microphone records a take (a take with your voice shouldn't have Director's in it).

With "use the original audio", the take records no sound and the original plays while
filming; the finished short is silent, for the original sound to be added when posting
on YouTube ("Use this sound"). Director never downloads a YouTube video.

## Phones

`getUserMedia` and DeviceOrientation need a secure context: `http://localhost` on the
computer itself, or HTTPS. To try it on a phone on the same Wi-Fi, run the web app over
HTTPS (`next dev --experimental-https`, or a tunnel) and open it by the computer's address.
iOS asks before a page may read the tilt: the level shows a button for that.

## Where things are

- Data: `ai.director_plan` (one per workspace and video, shared by its members),
  `ai.director_take` (each member's own), `app.short_reaction` (likes and saves); all under
  row-level security. Plans are a JSON column validated by `ShotPlan` on the way in and out.
- AI service: `apps/ai/app/director.py` (the three Gemini calls, their token budgets and
  failures), queue `ai-director` (`plan`, `review-take`) in `packages/jobs`.
- API: `apps/api/src/modules/shorts` (YouTube; `youtube.ts` is the only code that knows its
  wire format), `apps/api/src/modules/director` (checks, then the AI service).
- Contracts: `packages/contracts/src/api/{shorts,director}.ts`; the plan's shape is checked
  against the Python model by `apps/api/src/modules/director/limits.test.ts`.
- Web: `apps/web/src/modules/shorts` and `apps/web/src/modules/director` (`lib/` holds the
  pure parts: tilt, pose, framing, timeline, doodles, the edit, the stitcher).

## Limits

- A take is at most 60 seconds and 15 MB, so it stays under the 20 MB Gemini takes inline
  in one request once base64 has grown it; the recorder aims at 1.5 Mbit/s.
- YouTube's free quota is 10,000 units a day and a search costs 100: feed pages are cached
  for 30 minutes, videos for an hour, comments for ten minutes.
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
