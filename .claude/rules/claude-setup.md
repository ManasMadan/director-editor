---
paths:
  - ".claude/**"
  - "CLAUDE.md"
  - "**/CLAUDE.md"
  - ".mcp.json"
---

# The Claude Code setup

- `.claude/settings.json` and `.claude/hooks/` are guard rails: the edit guard asks the
  user before either changes. Don't weaken a check to get past it; if a hook is wrong,
  say how and let the user decide.
- A new `lint:*` script (or `codeql`) goes in `settings.json`'s `allow` list twice, bare
  and with ` *`, like the others: `scripts/claude-setup.test.ts` fails until it does.
- Hooks are TypeScript run with Bun, one file per hook event plus shared code in
  `lib.ts`, `checks.ts`, `file-rules.ts`, `shell.ts` and `suppressions.ts`. Logic lives
  in those shared modules with a `*.test.ts` beside each. Each hook exports a handler
  that takes the event, and what it would run or check as parameters with the real ones
  as defaults, and returns its answer; the file ends with
  `await runMain(import.meta, hookMain(handler))` (`runMain` in scripts/lib.ts, `hookMain`
  in lib.ts: `runHook` reads the event from stdin and writes the answer). Tests call the handler with stand-ins. `tsc -p .claude/hooks` runs in
  `bun run check-types`, and `bun test ./.claude/hooks/` in the pre-push hook and CI. A hook fails
  closed where a wrong "allow" is costly, and every message it sends says what to do.
- Skills are `.claude/skills/<name>/SKILL.md`: frontmatter, then numbered steps with the
  exact files, commands and tests, ending with how to check it's done (the verify skill,
  and the reviewer agents that apply). Only fields Claude Code documents
  (code.claude.com/docs/en/skills): `description` says what and when, `argument-hint`
  for arguments, `disable-model-invocation: true` for anything a human should start
  (releases, rollbacks, secret rotation, seam swaps). Skills are also the human
  runbooks: plain steps, no reliance on hidden context.
- Agents are `.claude/agents/<name>.md` with `name`, a `description` that says when to
  use it proactively, `tools`, `model` and `permissionMode`. Read-only agents set
  `disallowedTools: Edit, Write, NotebookEdit`. Fields as in
  code.claude.com/docs/en/sub-agents.
- Rules are `.claude/rules/<area>.md` with `paths` frontmatter (the only field Claude
  Code reads); they state this repo's conventions for those files, not general advice.
- `.claude-plugin/` publishes this setup as a plugin for apps made from the template:
  `plugin.json` lists every agent and carries the same hooks as `settings.json`, from
  the plugin's own copy (`${CLAUDE_PLUGIN_ROOT}` for `$CLAUDE_PROJECT_DIR`).
  `scripts/claude-setup.test.ts` fails when they drift; `claude plugin validate .`
  checks the manifests.
- Plugins: `enabledPlugins` in `settings.json` turns on Worktrunk and, from Anthropic's
  marketplace (`claude-plugins-official`, which Claude Code adds by itself, so it isn't
  in `extraKnownMarketplaces`), the ones below. The template's plugin lists the same
  ones as `dependencies`, and `scripts/claude-setup.test.ts` fails when either list
  loses one. The project's settings turn a plugin on but don't download it: each person
  runs `claude plugin install <name>@claude-plugins-official --scope project` once per
  plugin. None needs an account or a paid service here, and each fails soft without what
  it needs:
  - `typescript-lsp` and `pyright-lsp`: go to definition, references and diagnostics
    after each edit. They start `typescript-language-server` and `pyright-langserver`
    from PATH (`bun add -g typescript-language-server pyright`; `bun run doctor` says
    when they're missing). The root `pyproject.toml` only points pyright at `apps/ai`
    and its `.venv`; the type check that counts is still basedpyright's strict one.
  - `expo`, `stripe` and `redis-development`: skills. The Expo and Stripe plugins also
    bring remote MCP servers (mcp.expo.dev, mcp.stripe.com) that stay unconnected until
    someone signs in from `/mcp`; nothing here needs them. Local billing is the fake
    Stripe (`bun run stripe:fake`), so ignore the Stripe plugin's start-of-session hint
    to install its CLI and `stripe login`. The Redis skills fit Valkey for what this
    repo does (BullMQ, cache, rate limits); the search, vector and semantic-cache ones
    are for Redis-only modules it doesn't run.
  - `terraform`: HashiCorp's MCP server, run with `docker run`, for provider and module
    docs from the public registry (OpenTofu uses the same providers). It needs Docker
    and the network but no account: `TFE_TOKEN` stays unset, and its HCP Terraform
    tools are unused.
  - `security-guidance`: hooks only. A warning after an edit that matches a risky
    pattern, and a model review of the diff when a turn or subagent ends and of each
    commit, with the session's own Claude credentials. It needs Python 3.10 or later,
    and installs the Agent SDK into `~/.claude/security/` at session start. Its review
    hooks run in the background (`asyncRewake`) and come back as a follow-up message,
    so they never block a stop the way `verify-turn.ts` does, and it doesn't format,
    so nothing runs twice. To turn parts off on your machine, set `ENABLE_STOP_REVIEW=0`,
    `ENABLE_COMMIT_REVIEW=0` or `SECURITY_GUIDANCE_DISABLE=1` in the `env` of
    `.claude/settings.local.json`.
  - Not the `playwright` plugin: it is Playwright's MCP server. Claude drives a browser
    with Playwright's CLI instead, through Playwright's own skills below.
- Vendor skills: `.claude/skills/playwright-cli` and `playwright-trace` are Playwright's,
  copied in by its own installers from the root `playwright-core`; never edit them.
  Renovate's Playwright group reinstalls them on each update (`postUpgradeTasks` in
  `renovate.json5`, allowed one by one in `renovate.yml`), and `scripts/playwright.test.ts`
  fails when they differ from the installed version's and prints those commands.
  Playwright's third skill, `playwright-component-testing`, stays out: it builds a story
  gallery, and components here are tested with Storybook's `play` functions. The `playwright-cli` skill runs a bare
  `playwright-cli`: `.claude/bin/playwright-cli` starts the CLI from the project's
  `playwright-core`, and `session-start.ts` puts `.claude/bin` on the PATH of Claude's
  shell (through `CLAUDE_ENV_FILE`). `settings.json` allows `playwright-cli` and
  `npx playwright trace`.
- Keep in sync in the same change: a new skill goes in `docs/README.md`'s runbook list;
  a new agent, rule area or MCP server in `CLAUDE.md`'s "Claude Code setup"; a new
  command in `CLAUDE.md`'s table. Every app and `packages/db` has a `CLAUDE.md` with its
  commands, where things are, and its gotchas.
- `CLAUDE.md` and the rules are loaded into every session: keep them short and
  specific. No decision IDs, no history, no mention of private notes.
