# Director v2, slice 1: one safe shoot screen

The product definition is docs/superpowers/specs/2026-10-18-director-ux-redesign.md (the spec). It
is untracked in the main checkout at
/Users/manas.madan/Desktop/code/director-editor/docs/superpowers/specs/; copy it and
2026-10-18-director-uat.md into your branch and commit them first, as they are
(`docs(docs): add Director's UX redesign spec and UAT guide`).

Read first: the spec's section 1 (the one-page summary), 3 (what went wrong), 4 (principles), 6 (the
shoot screen in depth — all of it, especially 6.2's removals), 12 slice 1, 14 (quality bar) and 15
(slice 1's UAT script). Also the root-cause note
.superpowers/sdd/2026-10-18-director-hackathon/live-call-fix-report.md in the main checkout.

## Slice 1 (from the spec)

One screen; Live starts on "Start shooting"; front camera with flip; all removals from 6.2; camera
and Live stay up across shots; sessions rotate silently; `live` added to `system.info` features; the
per-take baseline (a shutter and a cancellable 3-2-1, nothing else starts a take).

Acceptance (the spec's words): say "okay let me go to the kitchen", "go", "ready", "let's go":
nothing starts; raise both hands, walk out of frame: nothing starts. The only controls are flip, the
shutter, the text box. Flip mid-conversation: Director comments on the new view. Ten shots past ten
minutes: no "call ended".

Removals include at least: the spoken action-word list, the raised-hand trigger, any timer or framing
auto-start, the screen-share button, mute, video on/off, the phone/"Call Director" button and every
"call"/"mode" wording, the scripted on-device loop as a user-facing mode (it survives only per the
spec's fallback, which is slice 6 — until then, if Live can't start, show the spec's honest notice and
keep the per-take baseline), and scene-check doodles that aren't grounded (grounded marks are slice
11; until then draw none).

## How to build

Branch `feat/mm/director-v2` from origin/master (`git fetch origin && git checkout -B
feat/mm/director-v2 origin/master`). This branch collects every v2 slice; push it after each
coherent step. Read CLAUDE.md and the rules for web, api, ui, i18n, contracts, tests. TDD. Tests:
the live-call browser tests use a FakeSocket; add whatever the spec says tests need (a Live stand-in
in the mock Google, per section 16). Every string through i18n; a11y per the quality bar.

Machine constraint (owner): no broad browser suites locally. You may run single browser test files
filtered to what you change, on your own stack (`bun run setup --stack 5`; `bun run db:down` at the
end). Run lint, check-types, unit, the api live tests, `bun run gen` drift-free. CI runs the rest
when the controller opens the PR.

Evidence: screenshots of the new shoot screen at phone size (playwright-cli with a fake camera, or
Chromium's `--use-fake-device-for-media-stream`) saved under
/Users/manas.madan/Desktop/code/director-editor/.superpowers/sdd/2026-10-18-director-hackathon/v2-evidence/
(write evidence there via the scratchpad if the worktree guard refuses, and say where).

Commits: `--no-verify`, Conventional with a workspace scope, first person, never mention AI/Claude/
co-authors. Never `git stash`. Report to v2-slice-1-report.md next to this brief (or your scratchpad
if refused): what changed, each acceptance check and how it's proven, the evidence paths, commits,
tests, and anything the spec got wrong. Return a short status.
