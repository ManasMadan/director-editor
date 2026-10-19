# Findings register (every finding, logged the moment it lands)

Sources: reviews/ (full text of each review), uat-open-issues.md (owner-found bugs, stay open until the
owner re-tests). Status: open → assigned <branch> → fixed <sha/PR> → verified. Severity as the reviewer gave it,
after I checked it against the code where noted ("verified").

## Release blockers (v1.7.0 waits on these)

| ID | Sev | Finding | Source | Status |
|---|---|---|---|---|
| B1 | blocker (verified) | TakeReview.index lists send maxItems to Vertex → every take review fails | investigation, review-python | fixed PR #39 738d3c0 (not deployed) |
| B2 | blocker | EditorDraft actions/choices maxItems → every editor request fails on Vertex | review-python | fixed PR #39 738d3c0 (not deployed) |
| B3 | major | LocateDraft.box_2d min/maxItems 4 → point_at may fail on Vertex | review-python | fixed PR #39 738d3c0 (not deployed) |
| B4 | blocker (verified) | session pass ON CONFLICT (session_id, part_index, start_ms) has no unique index → every pass insert fails | review-migrations | fixed PR #43 a2d815d (in v1.7.0) |
| B5 | blocker | Live: messages sent at socket open are lost (listener attached after awaits) → Director starts with original plan, never hears roll is on | review-api | fixed PR #38 c69656a (not deployed) |

## Live conversation (fix/mm/live-turns)

| ID | Sev | Finding | Source | Status |
|---|---|---|---|---|
| L1 | major | relay notes / shot briefs sent mid-turn interrupt Director (U3) | investigation, review-api | fixed PR #38 c69656a (not deployed) |
| L2 | major | go_to_shot obeyed right after plan change → shot jumps (U4) | investigation | fixed PR #38 c69656a (not deployed) |
| L3 | major | roll/take state dropped before setupComplete, not restated on rotation | review-api | fixed PR #38 c69656a (not deployed) |
| L4 | major | reconnect after network drop refused with CONFLICT; no ws heartbeat; orphan Gemini session billed | review-api | fixed PR #38 c69656a (not deployed) |
| L5 | major | adapt_shot twice wipes earlier changes (zod 4 keeps undefined keys) | review-api | fixed PR #38 c69656a (not deployed) |
| L6 | major | rotation swaps connection mid-turn, drops pending tool answer and recent speech | review-api | fixed PR #38 c69656a (not deployed) |
| L7 | major | short network stall → DIRECTOR_CALL_TOO_FAST ends call; 1 MiB buffered ends call | review-api | fixed PR #38 c69656a (not deployed) |
| L8 | minor | quiet nudge fires while a tool call is pending (replan up to 30 s) | investigation, review-api | fixed PR #38 c69656a (not deployed) |
| L9 | minor | tool answer deadlines shorter than the work (replan 30 s vs 25 s+hops; point_at 12 s vs 20 s) | review-api | fixed PR #38 c69656a (not deployed) |
| L10 | minor | ~half the camera frames dropped by the 1000 ms relay gate; browser ignores bufferedAmount | review-api | fixed PR #38 c69656a (not deployed) |
| L11 | minor | revise overwrites version changes saved while it runs | review-api | fixed PR #38 c69656a (not deployed) |
| L12 | — | captions late (U2): transcript after audio by Gemini design + whole-screen re-render per chunk | investigation | fixed PR #38 c69656a (not deployed) |
| L13 | unverified | proactive audio / affective dialog on v1 endpoint may be refused or make Director skip app notes | investigation, review-api | verified 10-19: v1 accepts proactivity + enableAffectiveDialog (setup ok, reply 1.55 s vs 1.39 s baseline); watch in UAT whether Director skips app notes |

## Reviews and AI service (fix/mm/reviews)

| ID | Sev | Finding | Source | Status |
|---|---|---|---|---|
| R1 | blocker (verified) | reviews use the original shot, not the member's version + memory (U5); version has no title | investigation, review-python, review-api | fixed PR #39 738d3c0 (not deployed) |
| R2 | major | review failures under burst (429/5xx, 3 tries in ~15 s) (U6) | investigation | fixed PR #39 738d3c0 (not deployed) |
| R3 | major | reservations hand out slivers → run fails after being paid; ledger overruns | review-python | fixed PR #39/#41 (not deployed) |
| R4 | major | session pass: no low video resolution, fixed 150k reservation, retries deterministic failures | review-python | assigned |
| R5 | major | concurrent asset jobs draw the same row twice (double Veo bills) | review-python | assigned |
| R6 | major | review / create can hang forever ("reviewing"/"analyzing") on unexpected errors | review-python | assigned |
| R7 | minor | lost queue adds never re-queued (add_take, create, pass reconcile) | review-python | assigned |
| R8 | minor | proofreading call and Nano Banana thought tokens not counted | review-python | assigned |
| R9 | minor | VEO_MODEL= can't turn clips off (env_ignore_empty) | review-python | assigned |
| R10 | minor | alignment failure after Gemini answered settles 0 tokens | review-python | assigned |
| R11 | minor | review after 30-min read URL expiry → permanent 403 | review-python | fixed PR #39/#41 (not deployed) |
| R12 | minor | aligner ffmpeg leaks on cancel; clipper sync 1.2 GB writes in async | review-python | assigned |
| R13 | minor | session_recordings.py pyright ignores unlisted; own BullMQ Queue outside queues.py | review-python | open |
| R14 | minor | EditorAction/Choice/Reply unconstrained; limits test misses new request models | review-python | open |

## Security, data, migrations (fix/mm/hardening)

| ID | Sev | Finding | Source | Status |
|---|---|---|---|---|
| S1 | high | director.chat (slower line) outside the AI usage ledger; 30/min, no guest limit → unbounded Gemini spend | review-security | fixed PR #43 a2d815d (in v1.7.0) |
| S2 | medium | shared demo account: uploads, prompts, briefs, memory visible to the next visitor, never purged | review-security | fixed PR #43 a2d815d (in v1.7.0) |
| S3 | major | delete_recording_attempt_file trigger deletes any file past RLS; API update grant too wide | review-migrations | fixed PR #43 a2d815d (in v1.7.0) |
| S4 | major/low | storage never deleted: director_asset rows, pass `whole` composes, late slice PUTs | review-migrations, review-security | fixed PR #43 a2d815d (in v1.7.0) |
| S5 | major | aligner decodes member takes in the ai pod with all secrets (no jail, no protocol whitelist) | review-python | fixed PR #43 a2d815d (in v1.7.0) |
| S6 | major | session-pass job can be lost (only queued when finish flips status; sweeper never queues) | review-api | fixed PR #43 a2d815d (in v1.7.0) |
| S7 | minor | withStoryboards signs any key without prefix check; stock copies skip scan/sharp | review-security | assigned (storyboard) / open (stock) |
| S8 | process | migrations merged with failing required checks → guard: lint for reused policy names; make "CI passed" required | review-migrations | fixed PR #43 a2d815d (in v1.7.0) |
| S9 | major | rollback v1.6.0 → v1.5.0 unsafe once a template is created ('created' source, 'storyboard' origin) | review-migrations | noted (don't roll back past v1.6.0) |
| S10 | minor | NOT VALID constraints never validated; purge not batched; app_ai insert grant wide; origin columns no check; no guest_until index; redundant file_id index; director_asset.file_id no FK; stale comments; Squawk warnings in director_version | review-migrations | open |
| S11 | unverified | production TURNSTILE_* / DEMO_PASSWORD / bucket lifecycle rules set? | review-security | open (check) |

## Export (fix/mm/export-sync)

| ID | Sev | Finding | Source | Status |
|---|---|---|---|---|
| E1 | major | exported Short: one frame lasts 10.4 s, audio 38.9 s vs video 20.4 s, A/V offset, captions only at end (U7) | owner export, measured | fixed PR #40 2da247f (not deployed); re-verify in UAT run 2 |
| E2 | major | takes of 0.1–1 s reach the editor (U8) | owner UAT | fixed PR #42 97bb99b (not deployed) |

## Mine (controller) / not yet assigned

| ID | Sev | Finding | Source | Status |
|---|---|---|---|---|
| M1 | major | "use the second one" numbers takes by createdAt (clipper out of order, pass shifts); tally counts refused marks | review-api | open |
| M2 | major | checkScene removed in #37 without `!` → api-compat breaking | review-api | assigned CI agent |
| M3 | minor | stock provider failures → INTERNAL not UPSTREAM_UNAVAILABLE; failed adds leave objects | review-api | open |
| M4 | minor | synthetic flag computed from slot choices, not the saved cut; ignores realistic AI images | review-api | open |
| M5 | — | CI red on master (unit, type-check; rest unknown) | CI | assigned fix/mm/ci-green |
| M6 | — | Frontend review | review-frontend | landed, see F1-F22 |

## Frontend (review-frontend.md, landed 10-19)

| ID | Sev | Finding | Source | Status |
|---|---|---|---|---|
| F1 | blocker (repro'd by reviewer in Chromium) | edit.tsx:179 heldPicture fetch(data:/blob:) blocked by prod CSP connect-src → every save fails (new in #36, not deployed) | review-frontend | fixed PR #40 2da247f (not deployed); re-verify in UAT run 2 |
| F2 | major | stitch.ts render driven by rAF: page hidden/locked → frozen frame + video plays past end into audio; MediaRecorder pause/resume per segment fragile (owner's export) | review-frontend | fixed PR #40 2da247f (not deployed); re-verify in UAT run 2 |
| F3 | major | every unfilmed shot becomes a held-frame gap with captions burned in; save allowed with 1 filmed shot | review-frontend | fixed PR #40 2da247f (not deployed); re-verify in UAT run 2 |
| F4 | major | roll.ts flip waits for the whole upload backlog (up to 5 min) while REC shows recording | review-frontend | assigned fix/mm/shoot-web |
| F5 | major | slice dropped when queue full leaves a hole → every later attempt in that part never becomes a take | review-frontend | assigned fix/mm/shoot-web |
| F6 | major | upload errors / near-limit never shown; SavingFootage has no way out offline | review-frontend | assigned fix/mm/shoot-web |
| F7 | major | iOS: AudioContext suspended on lock never resumed → Director silent and deaf after unlock | review-frontend | assigned fix/mm/shoot-web |
| F8 | major | camera flip opens new camera before stopping old → Android NotReadableError → "no camera" | review-frontend | assigned fix/mm/shoot-web |
| F9 | major | shot not reconciled with version: replan can leave member on a skipped/gap shot; go_to_shot to gaps; skip_shot on last shot leaves mid-roll for /edit | review-frontend | fixed PR #38 c69656a (not deployed) |
| F10 | major | use-your-version replan overwrites changes made during it; revise not in the save mutation scope | review-frontend | fixed PR #38 c69656a (not deployed) |
| F11 | major | editor choices only in useState → lost on reload and on reshoot round-trip | review-frontend | assigned fix/mm/shoot-web |
| F12 | major | realtime invalidation re-runs alignMatchCut (Gemini) on every director/recording change | review-frontend | assigned fix/mm/shoot-web |
| F13 | major | captions drawn on arrival, not on the audio clock; done at generation end; interrupted keeps unspoken words; slower line caption before voice, TTS awaited in turn queue | review-frontend | fixed PR #38 c69656a (not deployed) |
| F14 | minor | pause doesn't flush recorder (requestData on pause/pagehide) | review-frontend | assigned fix/mm/shoot-web |
| F15 | minor | flip while roll starting records a stopped stream | review-frontend | assigned fix/mm/shoot-web |
| F16 | minor | visuals.ts / match-ghost off-DOM video no preload, no timeout → render stuck at 0% on iOS | review-frontend | assigned fix/mm/export-sync |
| F17 | minor | wake lock resolved after unmount never released | review-frontend | assigned fix/mm/shoot-web |
| F18 | minor | dictation started without a tap (iOS not-allowed / mic conflict) — needs device check | review-frontend | open (UAT) |
| F19 | minor | a11y: TellBox no focus ring; Space handler hijacks buttons/dialog; gap-strip aria-label hides state; button inside label; autoplay tiles no pause | review-frontend | assigned fix/mm/shoot-web |
| F20 | minor | Tell-Director reply applied to stale choices | review-frontend | assigned fix/mm/shoot-web |
| F21 | minor | create brief lost on reload; failed brainstorm leaves double member turn | review-frontend | assigned fix/mm/shoot-web |
| F22 | minor | no e2e/a11y for create, roll shoot, asset picker, Tell Director; no test under real CSP or hidden page | review-frontend | assigned CI agent / fix branches |

## Production ops (found 10-19 03:45)

| ID | Sev | Finding | Source | Status |
|---|---|---|---|---|
| P1 | major (verified in prod logs) | worker files-cleanup and demo-retention fail the whole run on a GCS "No such object" (delete of a missing key) → files.object_deletion never drains; failing hourly since at least 20:20 UTC on 10-18 → storage leaks for every deleted file | worker logs | fixed PR #43 a2d815d (in v1.7.0) |

## UAT run 1 (prod v1.6.0, uat/uat-run-1.md has steps + evidence) — 3 blocker, 14 major, 15 minor, 6 polish

| ID | Sev | Finding | Owner |
|---|---|---|---|
| UAT1-15 | blocker | Director stuck in a `mark end` loop (~60 calls/90 s), silent, ignores member | fixed PR #44 e9d1610 (next release) |
| UAT1-07 | blocker | Director marks takes that never happened (its own line read, "hi I'm ready", idle) and misses real ones | fixed PR #44 e9d1610 (next release) |
| UAT1-17 | blocker | empty take files (261 B) = the "couldn't review" takes; Director's pick unplayable; Save blocked; reload undoes repick | fixed PR #39/#41 (not deployed) |
| UAT1-18 | major | roll recorder: MP4 codec description changed mid-recording (resolution change) — likely cause of broken takes | fix/mm/shoot-web |
| UAT1-16 | major | three-minute path can't save: Save disabled while any shot unfilmed, no reason shown | fixed PR #42 97bb99b (not deployed) |
| UAT1-20 | major | saved video 4.7 s vs edit 0:14 | partly: render rebuilt #40; remaining cause = Chrome encoder backlog under load -> drain+verify (no new dep) in progress; WebCodecs muxer needs OWNER approval (new dependency) |
| UAT1-21 | major | saved video silent | render keeps take sound (#40, tone test); silent takes trace to UAT1-17/18 recording side |
| UAT1-11 | major | phone: roll top bar pushes ✕ off-screen (x=610 on 390 px) | fix/mm/shoot-web |
| UAT1-27 | major | ✕ during roll leaves with no confirmation | fix/mm/shoot-web |
| UAT1-12 | major | closing tab / navigating leaves session "recording" forever; reopen starts a new one | fix/mm/shoot-web |
| UAT1-05 | major | shared demo: start card promises continuous recording then falls back to shutter silently | fix/mm/shoot-web |
| UAT1-06 | major | Start → first word 2.1–7.3 s (median 4.6, target 2.5); 3.8 s freeze after tap | partly #44 (connect before mic, parallel token; start logged in steps); 3.8 s tap freeze needs phone trace |
| UAT1-29 | major | replies 2.6–7 s when Director calls tools first | fixed PR #44 e9d1610 (next release) |
| UAT1-31 | major | some member turns never answered ("wait", "use the second one") | fix/mm/live-turns-2 |
| UAT1-28 | major | Director re-asks for market after member declined (B5/U5 family) | fix/mm/live-turns-2 (verify after #38) |
| UAT1-34 | major | member-indexed asset Short gets no asset slot → slices 9/10 unreachable | cause: Cloud Run indexer still on sha-58825810 (pre-assets) -> REDEPLOY indexer at prod commit after v1.7.0; guard merged #41 |
| UAT1-09 | major | captions trail voice 0.2–1.9 s although text arrives before audio (render path) | fix/mm/live-turns-2 (verify after #38) |
| UAT1-30 | minor | barge-in stops Director after 0.72 s (target 0.3) | OWNER DECISION 10-19: keep 400 ms prefix padding (echo safety over 0.3 s barge-in) |
| UAT1-08 | minor | quiet nudge fires over the member; caption sentences glued | fixed PR #44 e9d1610 (next release) |
| UAT1-10 | polish | Director says "plan" | fixed PR #44 e9d1610 (next release) |
| UAT1-32 | minor | "grandma" change overwrote an unrelated row | fixed PR #44 e9d1610 (next release) |
| UAT1-26 | minor | created template says "You, talking to the camera" for a no-talking brief | fixed PR #39/#41 (not deployed) |
| UAT1-02 | minor | sign-in CSP blocks Turnstile's data: probe | not ours: Cloudflare challenge frame CSP; our CSP allows documented Turnstile (test added #43) |
| UAT1-14, 35, 24, 36, 33, 19, 13, 23, 25, 22, 37, 01, 03, 04, 38 | minor/polish | editor board squeeze/clip, tap targets, contrast, quick start, save confirmation, wrap copy, review note follows take, create autosave, My media poster, post dialog, hero pill wrap, sign-in copy, template overlap | fix/mm/ui-polish |
| D1 | deploy | Cloud Run indexer+clipper redeployed at v1.7.0 (sha-a2d815d) | reviews-fix-report | done 10-19 |
| Q1 | owner decision | Export encoder backlog: proper fix = WebCodecs encode + an MP4 muxer library (new dependency). Mitigation without deps (drain wait + duration verify + one retry) in progress on fix/mm/export-sync | export-sync-report | OWNER DECISION 10-19: skip WebCodecs; keep drain+verify+retry (#52) |

## UAT UI run 1 (prod v1.6.0, uat/uat-ui-run-1.md, 304 screenshots) — 1 blocker, 13 major, 29 minor, 10 polish

| IDs | Sev | Area | Owner |
|---|---|---|---|
| UI1-31 | blocker | /privacy and /terms are template placeholders | fix/mm/legal-pages (new) |
| UI1-38, 39, 40, 41, 11 | major/minor | perf: LCP 4.5–6.8 s (TTFB 0.7–1.4 s, 2 web fonts), editor 1.3 s main-thread block + LCP 11.9 s (export/caption code eager), sign-in CLS 0.43, settings CLS 0.11, theme menu INP 272 ms; no favicon/manifest icons | fix/mm/perf (new) |
| UI1-20, 23, 45, 51, 24, 22 | major/minor | shared-demo start card honesty (=UAT1-05), ✕ during take stops it before Leave? (U8 family), shoot has no way out before start, landscape start card, line cut at 2 lines, 3 nudges in 25 s | fix/mm/shoot-web (UI1-22 → live-turns-2) |
| UI1-21 | major | Director hallucinates "bustling market" behind a green test pattern | fixed PR #45 886be8e (persona v7; verify in Live UAT) |
| UI1-13, 30 | major | paste field counts opening existing templates toward a 1-h lockout shared by all demo visitors; shared-demo account controls fail after use | fix/mm/hardening (resume) |
| UI1-42, 43, 29 | major | asset Short has no assets (= UAT1-34 stale Cloud Run indexer; redeploy D1); indexing progress copy; created template storyboards missing with no status | D1 redeploy + fix/mm/reviews (storyboards status) |
| UI1-26 | major | editor choices lost on reload (= F11) | fixed in fix/mm/shoot-web (pending merge) |
| UI1-01–10, 12, 14–18, 25, 27, 28, 32–37, 44, 46–50, 52, 53 | major..polish | responsive, copy, a11y, theme, forms, focus, tap targets, landscape editor | fix/mm/ui-polish |
| UI1-19 | minor | 502 once on "Talk it through" | check prod logs (controller) |
| D2 | ops | Cloud Run indexer/clipper are deployed by hand per release; since #41 a worker ignores an indexer on another release (falls back to local indexing) → every release needs a Cloud Run redeploy. Automate in deploy.yml (mirror image + gcloud run deploy with RELEASE) | controller | open (follow-up PR) |
