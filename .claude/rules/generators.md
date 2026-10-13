---
paths:
  - "turbo/generators/**"
---

# Code generators

`turbo/generators/config.ts` defines them (`bun run gen:new <name> --args ...`);
templates are Handlebars files in `templates/<generator>/`.

- What a generator writes must pass everything a pull request must: Biome, the
  boundary rules, knip, types, and its own tests. A template never contains code the
  repo bans (`as any`, suppressions, hand-written query keys, raw `fetch`).
- Each generator also wires what it wrote in (routers, modules, registries), and formats
  every file it touched, so its output needs no follow-up edit. Commit scopes need
  nothing: `commitlint.config.ts` reads the workspace folders.
- `config.ts`'s own logic (its questions, the event labels, the commands it runs) is
  unit-tested in `scripts/turbo-generators.test.ts` against a stand-in for plop, at 100%
  like every source file; the commands come in through `generator`'s second argument.
- `bun scripts/generators.ts` runs every generator into a scratch worktree and checks
  the output (CI's generators job runs it `--in-place`). Run it after changing a
  template; it takes minutes, so in the background.
- The matching skill (add-feature, add-package) says what the generator does and what
  is left to write by hand; update it with the generator.
