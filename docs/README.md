# Docs

New here: the [README](../README.md) says what Director is, how to try it and how to run
it, [how-it-works.md](how-it-works.md) what happens underneath,
[CONTRIBUTING.md](../CONTRIBUTING.md) has the conventions and everyday commands, and
[troubleshooting.md](troubleshooting.md) the fixes for what usually goes wrong. Starting a
new app from this repository: [new-project.md](new-project.md), the checklist from the
first clone to the first production release. `CLAUDE.md` is the same material condensed
for Claude Code.

| Doc | What's in it |
|---|---|
| [how-it-works.md](how-it-works.md) | Director underneath: indexing a Short (prompt, schema, retries and fallback, repair, stages, the evaluation), the live call (relay, audio formats, tools), take reviews and the best take, the editor, publishing, analytics |
| [architecture.md](architecture.md) | the deployables, production on Google Cloud, how a request flows, where each concern lives, the seams, a glossary |
| [troubleshooting.md](troubleshooting.md) | what the doctor's messages mean, ports, Docker memory, ClamAV, tests that refuse to start |
| [environment.md](environment.md) | every environment variable, which service reads it and what it switches on |
| [database.md](database.md) | schemas and owners, roles, row-level security, migrations, test databases, the restore drill |
| [codegen.md](codegen.md) | what `bun run gen` generates and from what, and the CI checks on it |
| [jobs-and-events.md](jobs-and-events.md) | queues, typed jobs, the outbox and relay, the event catalog, adding a job or event |
| [auth.md](auth.md) | sign-in methods, sessions, the personal workspace and roles, rate limits |
| [notifications.md](notifications.md) | email: templates, delivery, suppression, adding a notification |
| [files.md](files.md) | the upload pipeline and storage |
| [python-services.md](python-services.md) | apps/ai: Director's service, the worker, budgets |
| [director.md](director.md) | Director: the library of templates, Gemini's shot plans, the guided camera, take reviews and the finished short |
| [web-and-mobile.md](web-and-mobile.md) | the render-only web app, packages/client and packages/ui |
| [observability.md](observability.md) | the activity logs: what every service logs about who did what, what it never logs, and following one person in Grafana |
| [testing.md](testing.md) | every test layer and its command, the coverage rule, what CI runs and when |
| [deploy.md](deploy.md) | images, environments, staging and production releases, rollback, previews |
| [new-project.md](new-project.md) | everything a new app made from this director-editor needs once, in order |
| [repository-settings.md](repository-settings.md) | the GitHub settings (and the `gh` commands that apply them), App, environments and secrets the workflows need |
| [enhancements.md](enhancements.md) | what the template could do but doesn't yet, why, and what each would take |

Elsewhere: [deploy/README.md](../deploy/README.md) (charts and GitOps),
[infra/tofu/README.md](../infra/tofu/README.md) (k3s on your machines, Cloudflare).

## Working with Claude Code

The repo is set up for Claude Code: `CLAUDE.md` and path-scoped rules, skills for every
lifecycle task (setup, dev, add a feature, change the database, deploy, release, roll
back, swap a seam), review agents, and hooks that format on edit, guard generated files
and secrets, and run the affected tests before a turn ends. The skills are plain
step-by-step runbooks, readable without Claude too (below).

## Runbooks

The step-by-step procedures live in `.claude/skills/<name>/SKILL.md`. Claude Code runs
them, but each is a plain Markdown checklist you can follow by hand.

| Runbook | For |
|---|---|
| [setup](../.claude/skills/setup/SKILL.md) | a new machine, or repairing a broken local environment |
| [dev](../.claude/skills/dev/SKILL.md) | starting the local stack and its optional services |
| [debug](../.claude/skills/debug/SKILL.md) | following one failing request, job or email through the logs, locally, in CI or a cluster |
| [verify](../.claude/skills/verify/SKILL.md) | every check to run before calling a change done |
| [playwright-cli](../.claude/skills/playwright-cli/SKILL.md) | looking at the running app in a real browser from the shell, with the Playwright CLI (Playwright's own skill) |
| [playwright-trace](../.claude/skills/playwright-trace/SKILL.md) | reading the trace of a failed end-to-end test (Playwright's own skill) |
| [prisma-cli](../.claude/skills/prisma-cli/SKILL.md) | the Prisma 7 CLI: generate, migrate, db, studio (Prisma's own skill) |
| [prisma-client-api](../.claude/skills/prisma-client-api/SKILL.md) | writing Prisma Client queries: filters, relations, transactions (Prisma's own skill) |
| [prisma-orm-setup](../.claude/skills/prisma-orm-setup/SKILL.md) | troubleshooting Prisma's connection to the database (Prisma's own skill) |
| [add-feature](../.claude/skills/add-feature/SKILL.md) | a resource end to end: contract, API module, client hook, web page, tests |
| [db-change](../.claude/skills/db-change/SKILL.md) | a schema change: migration, row-level security, grants, expand then contract |
| [add-job](../.claude/skills/add-job/SKILL.md) | a background job, scheduled task or event consumer, in TypeScript or Python |
| [add-notification](../.claude/skills/add-notification/SKILL.md) | an email notification |
| [add-package](../.claude/skills/add-package/SKILL.md) | a new shared package under `packages/` |
| [add-python-module](../.claude/skills/add-python-module/SKILL.md) | an endpoint or module in the AI service, called from the API |
| [add-web-page](../.claude/skills/add-web-page/SKILL.md) | a page, route or component in the web app or `packages/ui` |
| [add-translation](../.claude/skills/add-translation/SKILL.md) | user-facing text, or a new language |
| [add-env-var](../.claude/skills/add-env-var/SKILL.md) | a setting or secret, locally and in every environment |
| [add-error-code](../.claude/skills/add-error-code/SKILL.md) | an error code with its status and messages |
| [add-webhook-provider](../.claude/skills/add-webhook-provider/SKILL.md) | receiving a new provider's webhooks |
| [add-seam](../.claude/skills/add-seam/SKILL.md) | putting a replaceable integration behind an interface |
| [add-app](../.claude/skills/add-app/SKILL.md) | a new deployable service or app, wired everywhere |
| [add-helm-value](../.claude/skills/add-helm-value/SKILL.md) | a chart setting, or a cluster add-on |
| [new-project](../.claude/skills/new-project/SKILL.md) | renaming a fresh copy of the template and working through the new-project checklist |
| [remove-feature](../.claude/skills/remove-feature/SKILL.md) | removing an optional feature completely, tables last |
| [write-tests](../.claude/skills/write-tests/SKILL.md) | missing tests, and getting a file to 100% coverage |
| [fix-ci](../.claude/skills/fix-ci/SKILL.md) | a red CI run: find the failing step, reproduce it, fix the cause |
| [open-pr](../.claude/skills/open-pr/SKILL.md) | preparing, opening or reviewing a pull request, with the reviewer agents |
| [dependency-update](../.claude/skills/dependency-update/SKILL.md) | Renovate pull requests and the Bun catalog |
| [deploy](../.claude/skills/deploy/SKILL.md) | how a merge reaches staging, and checking the rollout |
| [release](../.claude/skills/release/SKILL.md) | tagging a version and promoting it to production |
| [rollback](../.claude/skills/rollback/SKILL.md) | undoing a bad deploy in staging or production |
| [preview](../.claude/skills/preview/SKILL.md) | a pull request's own environment, and why one isn't up |
| [rotate-secrets](../.claude/skills/rotate-secrets/SKILL.md) | rotating every kind of secret and key, in `.env` and in the SOPS files |
| `swap-*` (11) | moving a seam to another implementation; the README's "Scaling path" names each |
