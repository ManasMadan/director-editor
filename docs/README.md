# Docs

New here: the [README](../README.md) gets it running, [CONTRIBUTING.md](../CONTRIBUTING.md)
has the conventions, and [troubleshooting.md](troubleshooting.md) the fixes for what
usually goes wrong. Starting a new app from this repository:
[new-project.md](new-project.md), the checklist from the first clone to the first
production release. `CLAUDE.md` is the same material condensed for Claude Code.

| Doc | What's in it |
|---|---|
| [architecture.md](architecture.md) | the deployables, how a request flows, where each concern lives, the seams, a glossary |
| [troubleshooting.md](troubleshooting.md) | what the doctor's messages mean, ports, Docker memory, ClamAV, tests that refuse to start |
| [environment.md](environment.md) | every environment variable, which service reads it and what it switches on |
| [database.md](database.md) | schemas and owners, roles, row-level security, migrations, test databases, the restore drill |
| [codegen.md](codegen.md) | what `bun run gen` generates and from what, and the CI checks on it |
| [jobs-and-events.md](jobs-and-events.md) | queues, typed jobs, the outbox and relay, the event catalog, adding a job or event |
| [auth.md](auth.md) | sign-in methods, sessions, organizations and roles, API keys, OAuth for MCP, rate limits |
| [notifications.md](notifications.md) | channels, templates, preferences, digests, quiet hours, unsubscribe, adding a notification |
| [files-and-billing.md](files-and-billing.md) | the upload pipeline and storage; Stripe billing, plans and the fake Stripe |
| [python-services.md](python-services.md) | apps/ai: the assistant, retrieval, summaries, the worker, the MCP server, evals |
| [web-and-mobile.md](web-and-mobile.md) | the render-only web app, packages/client and ui, the Expo app, EAS and OTA updates |
| [testing.md](testing.md) | every test layer and its command, the coverage rule, what CI runs and when |
| [deploy.md](deploy.md) | images, environments, staging and production releases, rollback, previews |
| [new-project.md](new-project.md) | everything a new app made from this boilerplate needs once, in order |
| [repository-settings.md](repository-settings.md) | the GitHub settings (and the `gh` commands that apply them), App, environments and secrets the workflows need |
| [enhancements.md](enhancements.md) | what the template could do but doesn't yet, why, and what each would take |

Elsewhere: [deploy/README.md](../deploy/README.md) (charts and GitOps),
[infra/tofu/README.md](../infra/tofu/README.md) (k3s on your machines, Cloudflare),
[apps/mobile/maestro/README.md](../apps/mobile/maestro/README.md) (native flows).

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
| [add-feature](../.claude/skills/add-feature/SKILL.md) | a resource end to end: contract, API module, client hook, web page, tests |
| [db-change](../.claude/skills/db-change/SKILL.md) | a schema change: migration, row-level security, grants, expand then contract |
| [add-job](../.claude/skills/add-job/SKILL.md) | a background job, scheduled task or event consumer, in TypeScript or Python |
| [add-notification](../.claude/skills/add-notification/SKILL.md) | a notification by email, in-app, push or SMS |
| [add-package](../.claude/skills/add-package/SKILL.md) | a new shared package under `packages/` |
| [add-python-module](../.claude/skills/add-python-module/SKILL.md) | an endpoint or module in the AI service, called from the API |
| [add-web-page](../.claude/skills/add-web-page/SKILL.md) | a page, route or component in the web app or `packages/ui` |
| [add-mobile-screen](../.claude/skills/add-mobile-screen/SKILL.md) | a screen or tab in the Expo app |
| [add-translation](../.claude/skills/add-translation/SKILL.md) | user-facing text, or a new language |
| [add-env-var](../.claude/skills/add-env-var/SKILL.md) | a setting or secret, locally and in every environment |
| [add-error-code](../.claude/skills/add-error-code/SKILL.md) | an error code with its status and messages |
| [add-api-key-scope](../.claude/skills/add-api-key-scope/SKILL.md) | letting API keys call a procedure |
| [add-entitlement](../.claude/skills/add-entitlement/SKILL.md) | a feature or limit that depends on the plan |
| [add-mcp-tool](../.claude/skills/add-mcp-tool/SKILL.md) | a tool for MCP clients, in the api or the AI service |
| [add-webhook-provider](../.claude/skills/add-webhook-provider/SKILL.md) | receiving a new provider's webhooks |
| [add-seam](../.claude/skills/add-seam/SKILL.md) | putting a replaceable integration behind an interface |
| [add-app](../.claude/skills/add-app/SKILL.md) | a new deployable service or app, wired everywhere |
| [add-helm-value](../.claude/skills/add-helm-value/SKILL.md) | a chart setting, or a cluster add-on |
| [add-load-test](../.claude/skills/add-load-test/SKILL.md) | a k6 scenario and its latency budget |
| [new-project](../.claude/skills/new-project/SKILL.md) | renaming a fresh copy of the template and working through the new-project checklist |
| [remove-feature](../.claude/skills/remove-feature/SKILL.md) | removing an optional feature completely, tables last |
| [write-tests](../.claude/skills/write-tests/SKILL.md) | missing tests, and getting a file to 100% coverage |
| [fix-ci](../.claude/skills/fix-ci/SKILL.md) | a red CI run: find the failing step, reproduce it, fix the cause |
| [open-pr](../.claude/skills/open-pr/SKILL.md) | preparing, opening or reviewing a pull request, with the reviewer agents |
| [dependency-update](../.claude/skills/dependency-update/SKILL.md) | Renovate pull requests, the Bun catalog, the Expo SDK |
| [deploy](../.claude/skills/deploy/SKILL.md) | how a merge reaches staging, and checking the rollout |
| [release](../.claude/skills/release/SKILL.md) | tagging a version and promoting it to production |
| [rollback](../.claude/skills/rollback/SKILL.md) | undoing a bad deploy in staging or production |
| [preview](../.claude/skills/preview/SKILL.md) | a pull request's own environment, and why one isn't up |
| [rotate-secrets](../.claude/skills/rotate-secrets/SKILL.md) | rotating every kind of secret and key, in `.env` and in the SOPS files |
| `swap-*` (15) | moving a seam to another implementation; the README's "Scaling path" names each |
