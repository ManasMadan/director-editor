# Rules for every Director v2 slice agent

- The product spec is the authority: docs/superpowers/specs/2026-10-18-director-ux-redesign.md (latest copy
  on origin/feat/mm/director-v2; the main checkout's copy may be newer). Read section 1, 4 (principles), your
  slice's sections, 12 (your slice's acceptance), 14 (quality bar) and 15 (your slice's UAT script). The owner
  is away and wants everything built today: where the spec is silent, make the best product call and note it.
- Many agents work in parallel on separate branches. Stay inside your slice's scope; prefer new files and
  small, well-named seams in shared files (contracts, the shoot screen, the editor page) so the controller can
  merge you with the others. Don't reformat or refactor code you don't need to touch.
- Setup: `git fetch origin && git checkout -B <your branch> <your base>`; then `bun install`, `bun run gen`.
  Your own service stack: `bun run setup --stack <your stack number>`; `bun run db:down` when done.
- Read CLAUDE.md and the .claude/rules for the areas you touch. TDD, real behaviour through the repo's fakes
  (mock Google, tests/fakes.py), 100% coverage of what you change, every string through i18n, a11y per the
  quality bar, no casts/`any`/suppressions, contracts and `bun run gen` for API changes, expand-only
  migrations with RLS and grants.
- Machine is shared by ~10 agents: NO broad browser or e2e suites. Run lint, check-types, unit tests, the
  integration tests for what you touch, and single browser test files filtered to your change. CI runs the
  rest.
- Commits: `--no-verify`, Conventional with a workspace scope, first person, never mention AI/Claude/
  co-authors, authored Manas Madan <manasmadan08@gmail.com> (check the first commit). Never `git stash`.
  Push often: `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin
  <branch>`. Don't open PRs (the controller does).
- Real Google services cost money: live calls to Vertex only when the slice needs a live check, a few at most.
- When done, write your report to the scratchpad and, if allowed, to
  /Users/manas.madan/Desktop/code/director-editor/.superpowers/sdd/2026-10-18-director-hackathon/v2-slice-<n>-report.md:
  what you built, each acceptance check and its proof, decisions, commits, tests, what the controller must
  deploy or configure. Return a short status. Don't dispatch subagents.

## Time box (owner, overrides the checks above)

The owner wants everything live within 3 hours. Hard time box: push working code within 2 hours. Checks:
lint, check-types and the unit tests of the packages you touch; write the tests your change needs but skip
integration, browser and coverage runs unless one is quick and essential. CI is fixed in a final PR after
all slices merge. Prefer shipping a complete, working slice over polish. Push every 30 minutes.
