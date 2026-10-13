# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# One image per Node service: api, worker, notifications, webhooks.
#
#   docker buildx bake api            (docker-bake.hcl at the repo root)
#
# The build prunes the monorepo to the service and its workspace packages, installs
# and bundles them, then ships only the bundle (dist/main.mjs, with our @repo/* code
# inlined) and the service's production npm dependencies on a distroless Node base: no
# shell, no package manager, running as an unprivileged user.

ARG BUN_IMAGE=oven/bun:1.3.6-slim@sha256:9d20d1b535596c4a021ba2087d2d303c4098e96be15f47775729cf7a259bb41e
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.5

FROM ${BUN_IMAGE} AS prune
ARG TURBO_VERSION
ARG SERVICE
WORKDIR /repo
COPY . .
RUN bunx turbo@${TURBO_VERSION} prune @repo/${SERVICE} --docker --out-dir /pruned

FROM ${BUN_IMAGE} AS build
ARG TURBO_VERSION
ARG SERVICE
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo
# Dependencies first (package manifests and the lockfile only), so code changes reuse
# the install layer.
COPY --from=prune /pruned/json/ .
RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY --from=prune /pruned/full/ .
COPY deploy/docker/check-peers.mjs /usr/local/lib/check-peers.mjs
# The Prisma client is the one generated file these services need that isn't committed
# (see docs/codegen.md); everything else is in the tree, so only this service builds.
RUN bun run --cwd packages/db gen \
 && bunx turbo@${TURBO_VERSION} run build --filter=@repo/${SERVICE} --only
# The runtime gets production dependencies only. Workspace links are dropped: our own
# packages are compiled into the bundle. No lifecycle scripts: the only one is the
# repo's own git-hook setup, and native modules ship prebuilt per platform.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && bun install --frozen-lockfile --production --ignore-scripts --filter @repo/${SERVICE} \
 && rm -rf node_modules/@repo \
 && bun /usr/local/lib/check-peers.mjs . \
 && mkdir -p /out/apps/${SERVICE} \
 && cp -r node_modules /out/node_modules \
 && cp -r apps/${SERVICE}/dist /out/apps/${SERVICE}/dist \
 && if [ -d apps/${SERVICE}/node_modules ]; then cp -r apps/${SERVICE}/node_modules /out/apps/${SERVICE}/; fi

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
ARG SERVICE
# The service's default port (docker-bake.hcl sets it from the service's env.ts), for the
# health check when nothing sets PORT; a deployment that does still wins.
ARG PORT
ARG RELEASE=dev
ENV NODE_ENV=production \
    PORT=${PORT} \
    RELEASE=${RELEASE}
# Files stay owned by root and read-only to the process; it writes nowhere but /tmp.
COPY --from=build /out /app
WORKDIR /app/apps/${SERVICE}
USER 10001:10001
# For plain Docker: Kubernetes ignores it and probes the same path (the stack chart).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["/nodejs/bin/node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health/live`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["--enable-source-maps", "--import", "./dist/telemetry.mjs", "dist/main.mjs"]
