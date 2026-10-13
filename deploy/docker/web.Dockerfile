# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# The web app (Next.js standalone server).
#
#   docker buildx bake web            (docker-bake.hcl at the repo root)
#
# Next traces exactly the files the server needs into .next/standalone, so the runtime
# image is that directory on a distroless Node base. Nothing environment-specific is
# baked in: every setting (WEB_URL, RELEASE, STORAGE_ORIGIN) is read when the server
# starts, so the same image runs in every environment. The one exception is API_URL (and
# AI_URL): Next fixes its rewrites at build time, so the image forwards /rpc and /api to
# localhost:3001, its default. Only local development and the end-to-end suite use those
# rewrites; in a cluster the gateway routes the paths to the api before Next sees them.

ARG BUN_IMAGE=oven/bun:1.3.6-slim@sha256:9d20d1b535596c4a021ba2087d2d303c4098e96be15f47775729cf7a259bb41e
# Next builds under Node: under Bun's runtime it can't load its own compiled server
# modules ("Expected CommonJS module to have a function wrapper"). Matches .nvmrc.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.5

FROM ${BUN_IMAGE} AS prune
ARG TURBO_VERSION
WORKDIR /repo
COPY . .
RUN bunx turbo@${TURBO_VERSION} prune @repo/web --docker --out-dir /pruned

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS build
ARG TURBO_VERSION
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx
ENV TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY --from=prune /pruned/json/ .
RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY --from=prune /pruned/full/ .
# The build validates configuration like the server does; this origin only satisfies
# that check (pages that use the origin render per request, from the runtime value).
RUN WEB_URL=http://build.invalid bunx turbo@${TURBO_VERSION} run build --filter=@repo/web --only

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
ARG RELEASE=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    RELEASE=${RELEASE}
COPY --from=build /repo/apps/web/.next/standalone /app
WORKDIR /app/apps/web
USER 10001:10001
EXPOSE 3000
# For plain Docker: Kubernetes ignores it and probes the same path (the stack chart).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["/nodejs/bin/node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Next writes its render cache under .next/cache: mount a writable volume there when
# the root filesystem is read-only (the Helm chart does).
CMD ["server.js"]
