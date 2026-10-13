# Contributing

## Getting started

You need Node 24 (`nvm use`), Bun 1.3, Docker and uv. uv isn't only for the AI service:
code generation runs its exporter, and setup, `bun dev`, types and tests all generate
code first, so `bun run doctor` fails without it. Or open the repository in its
devcontainer (VS Code, Codespaces), which has the tools and runs setup itself.

```sh
bun run setup      # once, and after a pull that adds variables: .env, dependencies, database
bun dev            # the core services; `bun dev:full` for everything
bun run doctor     # when something looks off
```

Local services run in Docker with memory limits and their own ports, so they sit
beside other projects' containers. Docker needs about 1.4 GB free for the core
(`bun dev`, `bun run test:integration`), about 3.4 GB for the file-upload tests
(`bun run test:integration:files`, with RustFS and ClamAV) and about 3.9 GB for the full
profile (`bun dev:full`, `bun run test:coverage`); the start refuses when they don't fit
([docs/testing.md](docs/testing.md#integration) has each profile). `bun run db:down` stops them; `bun run docker:clean` removes everything this
repository created in Docker. [docs/troubleshooting.md](docs/troubleshooting.md) has the
fixes for what usually goes wrong.

## Making a change

1. Branch from `master`: `<type>/<what>`, with a Conventional Commits type (`feat/`,
   `fix/`, `chore/`, …); a team can add who owns it (`feat/ada/<what>`).
2. Keep to the principles in `CLAUDE.md`: fix root causes, validate at every boundary,
   one implementation per concern, services never import each other, and every
   user-facing string goes through `packages/i18n`.
3. Before pushing: `bun run lint`, `bun run check-types`, `bun run test`, and for
   anything touching the database, queues or HTTP, `bun run test:integration`.
   `bun run test:e2e` builds and starts its own stack, so stop `bun dev` first. The git
   hooks help: on commit they format and lint the staged files (Biome, ruff, Prisma,
   `tofu fmt`, Squawk on migrations), scan them for secrets with gitleaks, and run CI's
   Trivy and OSV scans when you stage infrastructure code or a lockfile (each tool
   installed at CI's version, or through Docker); on push they run every check CI would
   run on the pull request that can run on your machine, for the areas you changed
   (`scripts/pre-push.ts`, see [docs/testing.md](docs/testing.md#before-a-push)). That can
   take a while for a change to shared code, and the end-to-end suite in it needs
   `bun dev` stopped; `git push --no-verify` skips it and leaves CI to decide.
4. Open a pull request. It's squash-merged, so its title becomes the one commit on
   master and follows
   [Conventional Commits](https://www.conventionalcommits.org) with a workspace scope:
   `feat(api): add todo sharing`, `fix(web): keep the draft on reload`. The scopes are in
   `commitlint.config.ts`. `feat` and `fix` end up in the changelog and the next version.

The branch must be up to date with master ("Update branch" on the pull request does it)
and the four gates must pass on it: **CI passed**, **Security passed**, **Kubernetes
passed** and **Infrastructure passed**. Auto-merge is on, so a pull request set to merge
lands as soon as they do. With a single maintainer the ruleset asks for no
approval (GitHub doesn't let you approve your own pull request); once there's a team, it
asks for one from a code owner (docs/repository-settings.md).

## Database changes

- Change the schema in `packages/db/prisma/schema/` (one file per area), then
  `bun run db:migrate` to write the migration. Never edit a migration that has shipped;
  write a new one.
- Migrations deploy before the code that uses them, and the previous release keeps
  running during a rollout, so every migration must work with both. Add first, backfill,
  switch the code, and drop in a later release. `bun run db:lint` (squawk) catches the
  locking and rewriting operations that would take production down.
- Tenant tables get forced row-level security and grants for the roles that need them,
  in the same migration. The integration tests connect as those roles, so a missing
  grant or policy fails there.

## Environment variables

A new variable goes in the service's `src/env.ts` (validated at boot), `.env.example`
and `docs/environment.md`, in the same change. Features switch on when their variables
are present, so a new integration stays off until it's configured.

## Releases

Every merge to `master` deploys to staging. A release is a version tag you push
(`git tag v1.4.0 && git push origin v1.4.0`): the release notes are built from the
commit titles since the last tag. `bun run promote v1.4.0` then opens the pull request
that points production at that version's images; merging it deploys. See
`docs/deploy.md`.

## Security issues

Never in a public issue: see [SECURITY.md](SECURITY.md).
