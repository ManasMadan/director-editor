# The development container: the Node, Bun, uv and OpenTofu versions CI and the images
# use (Renovate keeps them in step), and the tools shipping needs (docs/new-project.md,
# "Tools"): kind, helm-unittest, sops and age, and gh. Python itself comes from uv, which
# installs the version in apps/ai/.python-version on the first `uv sync`.
FROM oven/bun:1.3.6@sha256:f20d9cf365ab35529384f1717687c739c92e6f39157a35a95ef06f4049a10e4a AS bun
FROM ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc AS uv
FROM ghcr.io/opentofu/opentofu:1.11.10-minimal@sha256:b7e7856c6575cd2c38132d6fea0512bd0562ab7fd2e645d4868205e9dba4a1cb AS tofu

FROM mcr.microsoft.com/devcontainers/javascript-node:5.2.1-24-trixie@sha256:7a81958053c4e3b5b20fa122f7a422d32dd0eebe87a6726f7b14483585ea60fd
# renovate: datasource=npm depName=npm
ARG NPM_VERSION=11.21.0
# Debian's security updates, which the base image is weeks behind on between its own
# releases (as the ai image does), and a current npm in place of the one it bundles; the
# base's global eslint and pnpm go (Biome and Bun do their jobs here). scripts/image-scan.ts
# scans the result.
RUN apt-get update && apt-get -y upgrade && rm -rf /var/lib/apt/lists/* \
 && npm install --global --prefix /usr/local "npm@${NPM_VERSION}" \
 && npm uninstall --global --prefix /usr/local/share/npm-global eslint pnpm
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu

# Downloaded from each project's GitHub releases and checked against the checksums
# below, which are those releases' own (age publishes none: computed from its archives).
# A version and its checksums change together: Renovate's pull request says so.
# renovate: datasource=github-releases depName=kubernetes-sigs/kind
ARG KIND_VERSION=0.33.0
# renovate: datasource=github-releases depName=helm-unittest/helm-unittest
ARG HELM_UNITTEST_VERSION=1.1.2
# renovate: datasource=github-releases depName=getsops/sops
ARG SOPS_VERSION=3.13.3
# renovate: datasource=github-releases depName=FiloSottile/age
ARG AGE_VERSION=1.3.2
# renovate: datasource=github-releases depName=cli/cli
ARG GH_VERSION=2.102.0
# Set by BuildKit: amd64 or arm64.
ARG TARGETARCH
# helm itself comes from the devcontainer's feature, added after this image is built, so
# helm-unittest is unpacked where helm looks for the user's plugins.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /tmp/downloads
RUN case "$TARGETARCH" in \
      amd64) \
        kind=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d \
        unittest=de03d6b7ba7683282064702d0b36fbbe812ab2a22691fa3a8b2ce57c2682609c \
        sops=e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b \
        age=cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 \
        gh=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 ;; \
      arm64) \
        kind=20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2 \
        unittest=5f8d24d163b65a9244c4371078bfecaa236f7f6807fd8e923700783db78c1626 \
        sops=53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77 \
        age=6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4 \
        gh=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 ;; \
      *) echo "No checksums for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && get() { curl -fsSL --retry 3 -o "$1" "$2" && echo "$3  $1" | sha256sum -c -; } \
    && get kind "https://github.com/kubernetes-sigs/kind/releases/download/v$KIND_VERSION/kind-linux-$TARGETARCH" "$kind" \
    && install -m 0755 kind /usr/local/bin/kind \
    && get sops "https://github.com/getsops/sops/releases/download/v$SOPS_VERSION/sops-v$SOPS_VERSION.linux.$TARGETARCH" "$sops" \
    && install -m 0755 sops /usr/local/bin/sops \
    && get age.tar.gz "https://github.com/FiloSottile/age/releases/download/v$AGE_VERSION/age-v$AGE_VERSION-linux-$TARGETARCH.tar.gz" "$age" \
    && tar -xzf age.tar.gz \
    && install -m 0755 age/age age/age-keygen /usr/local/bin/ \
    && get gh.tar.gz "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_linux_$TARGETARCH.tar.gz" "$gh" \
    && tar -xzf gh.tar.gz \
    && install -m 0755 "gh_${GH_VERSION}_linux_$TARGETARCH/bin/gh" /usr/local/bin/gh \
    && get unittest.tgz "https://github.com/helm-unittest/helm-unittest/releases/download/v$HELM_UNITTEST_VERSION/helm-unittest-linux-$TARGETARCH-$HELM_UNITTEST_VERSION.tgz" "$unittest" \
    && mkdir -p /home/node/.local/share/helm/plugins/helm-unittest \
    && tar -xzf unittest.tgz -C /home/node/.local/share/helm/plugins/helm-unittest \
    && chown -R node:node /home/node/.local \
    && rm -rf /tmp/downloads/*
WORKDIR /
# The base image's own non-root user, which VS Code and Codespaces connect as anyway. By
# name, not its id: the dev container features this image takes (docker-in-docker, for
# one) find the user to set up by its name.
# hadolint ignore=DL3066
USER node
