# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# The Python AI service. One image, two processes: the HTTP service (default command)
# and the queue worker (`python -m app.worker`, set by the Helm chart).
#
#   docker buildx bake ai             (docker-bake.hcl at the repo root)
#
# Dependencies come from uv.lock exactly (no dev group), into a virtualenv that the
# runtime image copies as is. Python matches the lockfile's, so compiled wheels load.

ARG PYTHON_IMAGE=python:3.14-slim-trixie@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY apps/ai/pyproject.toml apps/ai/uv.lock ./
RUN --mount=type=cache,id=uv,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY apps/ai/app ./app

FROM ${PYTHON_IMAGE}
ARG RELEASE=dev
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RELEASE=${RELEASE}
# Debian's security updates the base image doesn't have yet: Python links the system
# OpenSSL, so a fix published after the python image was built must reach this one.
RUN apt-get update && apt-get -y upgrade && rm -rf /var/lib/apt/lists/*
# The base image's pip is never used (dependencies are in the virtualenv) and vendors
# its own, older copies of other packages, which scanners rightly flag: it goes.
RUN python -m pip uninstall --yes --root-user-action=ignore pip
# The code stays owned by root and read-only to the process.
COPY --from=build /app /app
WORKDIR /app
USER 10001:10001
EXPOSE 8000
CMD ["fastapi", "run", "app/main.py", "--host", "0.0.0.0", "--port", "8000"]
