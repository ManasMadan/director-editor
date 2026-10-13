# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# Database migrations: `prisma migrate deploy` as the migrator role, run once per
# release before the services roll out (the Helm chart's pre-install/pre-upgrade Job).
#
#   docker buildx bake migrate        (docker-bake.hcl at the repo root)
#   docker run --rm -e MIGRATOR_DATABASE_URL=postgresql://migrator:…@db:5432/app <image>
#
# Every migration must be safe to run while the previous release is still serving
# (expand, deploy, then contract in a later release).

ARG BUN_IMAGE=oven/bun:1.3.6-slim@sha256:9d20d1b535596c4a021ba2087d2d303c4098e96be15f47775729cf7a259bb41e
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.5

FROM ${BUN_IMAGE} AS prune
ARG TURBO_VERSION
WORKDIR /repo
COPY . .
RUN bunx turbo@${TURBO_VERSION} prune @repo/db --docker --out-dir /pruned

FROM ${BUN_IMAGE} AS build
WORKDIR /repo
COPY --from=prune /pruned/json/ .
# The Prisma CLI is a development dependency of the db package, and it's all this
# image runs, so it's a full install of that one package.
RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts --filter @repo/db
COPY --from=prune /pruned/full/ .
# (No peer check here, unlike the service images: this tree is the Prisma CLI's, whose
# bundled Studio UI declares React peers, and `migrate deploy` never loads it.)
# Migrations run on Prisma's schema engine, a native binary its postinstall downloads
# for this platform (the install above skips lifecycle scripts, so it runs here).
RUN rm -rf node_modules/@repo
WORKDIR /repo/node_modules/@prisma/engines
RUN bun scripts/postinstall.js && ls schema-engine-*

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/packages/db/prisma /app/packages/db/prisma
COPY --from=build /repo/packages/db/prisma.config.ts /app/packages/db/prisma.config.ts
COPY --from=build /repo/packages/db/package.json /app/packages/db/package.json
WORKDIR /app/packages/db
USER 10001:10001
CMD ["/app/node_modules/prisma/build/index.js", "migrate", "deploy"]
