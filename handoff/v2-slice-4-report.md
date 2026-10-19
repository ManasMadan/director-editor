# Director v2, slice 4: memory, adapting and re-planning (report)

Branch `feat/mm/v2-memory`, pushed: one commit, head `81e7e089`, rebased on origin/master
5f8d1a2, which has slices 10, 13 and 6. The tool checks now live in master's shared
`live.tools.ts` (`versionCall`, the `failed` response, and adapt's framing and camera),
so the slower line (`director.chat`) handles remember, forget, skip, restore and replan
too. Its turn carries the whole version (an optional `version`, with `adaptations` kept
for older screens) and a new `forgot` turn. A test in `live.chat.test.ts` covers this.
The live Vertex check was not run: this worktree has no `DIRECTOR_MODEL` and no Google
credentials. Conflicts with the roll (`mark`, `paused`, `not_recording`, `roll` and `mute`),
the assets work (`director-asset`, `ASSET_MODEL`) and marks are resolved by keeping both
sides. Generated files were taken from master and then regenerated. The migration is now
`20261018222000_director_version`.

## Built
- Contracts (`api/your-version.ts`):
  - `yourVersionSchema`: notes (the chips), per-shot changes (where, action, line, framing, camera), skipped shots and gaps;
  - `applyShotVersion`, one implementation shared by the web card and Director's briefs;
  - the procedures `yourVersion.get`, `save` and `revise`.
- Table `app.director_version`, migration `20261018220000_director_version`:
  - one row per org, user and video;
  - RLS, with checks on the video id and the JSON.
- API module `modules/your-version`.
- Client hooks `your-version`, `save-your-version` (saves scoped so they land in order) and `revise`.
- AI service: `POST /v1/director/plans/{video}/revisions`.
  - `app/revise.py` holds the prompt and `apply_revision`.
  - Budget feature `director-revise`, setting `DIRECTOR_TOKENS_PER_REVISE` (default 30000), documented in `.env.example` and `docs/environment.md`.
- Live:
  - new tools `remember`, `forget`, `restore_shot`, `skip_shot` and `replan` (30 s wait, the new version in its answer);
  - `adapt_shot` gains `framing` and `camera`;
  - a `failed` result;
  - `context` now carries the whole version, sent on connect and after every change;
  - new `forgot` and `restored` messages;
  - every brief shows the member's version of the shot plus a `<memory>` block;
  - persona v3 makes a change of place or setup plan-wide unless the member says "just this shot";
  - the mock Live API answers "switching indoors" and "one angle" with remember + replan, and "skip this one" with skip_shot.
- Shoot screen:
  - `use-your-version` hook;
  - MemoryChips, with × to forget;
  - ↺ restore on changed card rows, and a framing row;
  - skip moves to the next shot the member films;
  - kept takes skip skipped shots and gaps.
- Editor:
  - skipped shots and gaps get no clips and no picks;
  - captions use the member's lines;
  - VersionGaps lists the gaps and skips.

## Acceptance proof
- Headline repro, `live.test.ts` "a place change said once":
  - "I'm switching indoors" on shot 1 leads to remember + replan;
  - the briefs for shots 2 and 3 have no street or outdoor reference, and neither does a rotated connection's setup;
  - it failed before the fix.
- Chips and memory: relay tests and MemoryChips. "Never again" rests on the briefs plus the persona; not checked against real Gemini.
- One angle: the replan answer carries the version. Revise turns shots into gaps (Python and API integration tests). The editor lists the gaps.
- Reload: the version is stored. The API integration test covers save, get and workspace isolation. The browser sends `context` on connect.
- Skip: the screen moves on; the editor drops the shot.

## Tests
- Passed after the rebase onto 5a3fdfa:
  - contracts: 70;
  - api unit: 309 (env.test timed out once under load and passed on its own rerun);
  - web unit: 159;
  - fake-google: 31;
  - ai-client: 16;
  - client: 106;
  - Python: test_revise 4, and the re_plan integration tests 2;
  - basedpyright, lint and check-types: clean.
- The API integration test (4) passed before the last rebase. After it, the fresh-database migrations at 25bc891 failed on a duplicate `owner_functions` policy, which master fixed in #23.
- Not run: the browser tests (`director-live.test.tsx` was updated for the new context shape), e2e, coverage.

## For the controller
- The branch is already rebased on 5a3fdfa; `bun run gen` is run and committed.
- Deploy the migration and, optionally, `DIRECTOR_TOKENS_PER_REVISE`.
- Do one live Vertex check: the `RevisionDraft` schema is accepted, and Director calls remember + replan on "I'm switching indoors".
