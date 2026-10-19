# Slice 5 (picks with reasons, and the post-session pass): report

Branch `feat/mm/v2-picks` (from origin/master e8526d9), pushed through `14db288`. No PR.

## Built

- **Review reason (ai).** `TakeReview.reason` is one specific line, at most 160
  characters. It's stored in `ai.director_take.reason`, and the prompt judges "is it
  good", not "is it the same".
- **Member's choice.**
  - Migration `20261018220000_director_take_picks` (expand-only) adds `reason`,
    `chosen_at` and `origin` (default `'shoot'`) to `ai.director_take`.
  - AI route `POST /v1/director/plans/{video}/choices` allows one choice per shot and
    refuses with `DIRECTOR_TAKE_NOT_FOUND` unless it's the caller's take of that shot.
  - Contract `director.chooseTake` answers with the shots.
  - Takes carry `reason`, `chosen` and `origin`, and shots carry `chosenTakeId`.
- **`rate` in Director live (api).** `live.picks.ts` is the merge seam.
  - The relay handles `rate` itself. A per-shot tally (numbered from 1; a discarded take
    gives its number back) answers `new_best` and `best_take`.
  - `use: true` goes through `LivePicks.choose(shot, n)`, and `server.ts` `shootPicks`
    picks the nth take of the shot since the shoot started, then calls `chooseTake`.
  - The setup appends `RATE_DECLARATION` and `PICKS_PERSONA`.
- **Post-session pass (ai).** `app/session_pass.py`:
  - `GeminiWatcher` runs on `INDEX_MODEL` with a 150k-token `director-pass` budget.
  - `reconcile` is plain code: a stretch that overlaps a marked attempt by 50% or more is
    that attempt, re-cut only if an edge moved 0.5 s or more; anything else is new.
  - The seams are `RecordingSource` and `AttemptSink`, with the `NoRecordings` stand-in.
  - New job `ai-director/session-pass` `{sessionId, orgId}`, wired into the worker.
- **Editor (web).** The new `components/directors-picks.tsx` holds `PickBadges` and
  `BackToPicks`.
  - Takes are listed: "Your pick" first, then Director's pick with its reason, then the
    rest as filmed. Pass-found takes say "Found in your footage".
  - One tap swaps, and a live region announces the swap.
  - "Go back to Director's picks" can be undone.
  - The edit page changes by one import and one element.

## Checks

- **Python:** ruff, basedpyright, deptry and 216 unit tests pass. TypeScript check-types,
  biome and knip pass.
- **Unit tests pass:** api 282, contracts 57, web 128, ai-client 13, i18n 11.
- **Not run:** Python and API integration tests, and the browser file. Stack 2's Valkey
  port never bound, so every browser test timed out on a blank page, untouched ones too.

## Controller

- Implement the two recording seams against slice 3's tables, with grants for `app_ai`.
- Queue `session-pass` on `recording.finish`.
- Give pass takes `origin='pass'`.
- Feed `tally.onTake` from attempt ends.
- When merging with slices 2 and 4, append `PICKS_PERSONA` to the persona.
- There are no new env vars.
