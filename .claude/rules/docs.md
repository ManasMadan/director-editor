---
paths:
  - "docs/**"
  - "README.md"
  - "CONTRIBUTING.md"
  - "SECURITY.md"
  - "deploy/README.md"
  - "infra/tofu/README.md"
  - "apps/mobile/maestro/README.md"
---

# Docs

- Written for a person who hasn't seen the code: plain prose, short sentences, what to
  do and why. No decision IDs, ticket numbers, "as discussed", or references to private
  notes. Say what the code does now, not how it got there.
- Every claim is checked against the code before it's written: a path exists, a command
  is in a `package.json`, a default matches `src/env.ts`. The `docs-sync` agent checks
  them after a change.
- One home per fact: link to the doc that owns it instead of repeating it
  (environment variables in `docs/environment.md`, the seams in the README's "Scaling
  path", every doc in `docs/README.md`'s index, runbooks in its "Runbooks" list).
- Commands are written as they run from the repo root, in a fenced block or backticks.
- A new doc gets a row in `docs/README.md`. A doc a newcomer needs is linked from the
  README or CONTRIBUTING.
- Keep lines at about 90 characters and reflow a paragraph after editing it, so a
  sentence isn't split across a lone short line.
