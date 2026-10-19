# Director v2, slice 2: a two-way, flexible conversation

The spec is docs/superpowers/specs/2026-10-18-director-ux-redesign.md (on feat/mm/director-v2, updated with
slice 1's rulings). Read section 1, 2 (market patterns and anti-patterns), 6 in full (especially 6.7
events, 6.15 the persona and the example dialogues, the conversation model, the text box), 12 slice 2, 14
(latency budgets), and 15's slice 2 UAT script.

## Slice 2 (from the spec)

The persona (6.15); events (6.7); Director speaks after attempts and is silent during them; the text box;
low speech sensitivity; the flexibility rules.

Acceptance (the spec's words): "ok I'm going" gets an answer within about a second and a half; "say my
line again" (typed) works; the line said differently with the same meaning gets no correction; "what if I
do it with my grandma" gets a comment and a changed card; fifteen silent seconds bring one nudge, never
more than two a shot.

The owner's direction, which the spec encodes: Gemini does everything (every word Director says is
Gemini's, no canned lines); Director talks like a friend helping you shoot a reel (warm, casual, short,
playful, reacts to what it sees, celebrates good takes); it is flexible, never strict (paraphrase is fine,
the member's own version wins unless they ask for the original, it comments honestly to help them record
it better); it answers every turn.

"A changed card" for the grandma case: if the shot change needs the `adapt_shot` tool (slice 4), add the
minimum this acceptance needs (Director can rewrite the current shot's on-screen direction), or leave a
clear seam for slice 4 and make the persona propose the change in words, whichever the spec intends; note
your call.

## How to build

Branch: continue on `feat/mm/director-v2` (it has slice 1 and the spec, rebased on master fd9ef09). Pull
first. Read CLAUDE.md and the rules for api, web, i18n, tests. TDD; the mock Live stand-in in the mock
Google (from slice 1) is where conversation behaviour is pinned: events sent to Gemini at the right moments,
silence during attempts, nudges with their caps, text input reaching the session, Director's voice never
shown or played while muted. Put the persona and its example dialogues in the Live system instructions
(versioned, tested for presence of the key rules). Measure what you can of latency against the mock and
document how the 1.5 s budget is met in production (proactive audio / VAD settings, start-of-speech
sensitivity, turn coverage).

Machine constraint: no broad browser suites; single browser test files filtered to what you change, on
stack 5 (`bun run db:down` at the end). Lint, check-types, unit, API live tests, `bun run gen`
drift-free. Commits `--no-verify`, Conventional, first person, no AI mentions, authored Manas Madan
<manasmadan08@gmail.com>. Push as you go (use `-c credential.helper='!gh auth git-credential'` if HTTPS
asks for a username). Report to v2-slice-2-report.md next to this brief: what changed, each acceptance
check and its proof, evidence screenshots in v2-evidence/ (prefix 2-), commits, tests, calls you made.
