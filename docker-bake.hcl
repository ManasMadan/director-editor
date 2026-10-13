# Every deployable image, built the same way locally and in CI.
#
#   docker buildx bake                     all images, for this machine's platform
#   docker buildx bake api web             some of them
#   TAG=sha-abc123 REGISTRY=ghcr.io/you/boilerplate docker buildx bake --push \
#     --set '*.platform=linux/amd64,linux/arm64'
#
# Images are named <REGISTRY>/<name>:<TAG>. RELEASE (the git SHA in CI) is stamped into
# each image, so logs, errors and the web app report which build is running.

variable "REGISTRY" {
  default = "boilerplate"
}

variable "TAG" {
  default = "dev"
}

variable "RELEASE" {
  default = "dev"
}

group "default" {
  targets = ["api", "worker", "notifications", "webhooks", "web", "ai", "migrate"]
}

target "_common" {
  context = "."
  args = {
    RELEASE = RELEASE
  }
  labels = {
    "org.opencontainers.image.source"   = "https://github.com/ManasMadan/boilerplate"
    "org.opencontainers.image.revision" = RELEASE
  }
}

target "node-service" {
  name       = service
  inherits   = ["_common"]
  dockerfile = "deploy/docker/node-service.Dockerfile"
  matrix = {
    service = ["api", "worker", "notifications", "webhooks"]
  }
  args = {
    SERVICE = service
    # Each service's default port, as its src/env.ts has it (scripts/dockerfiles.test.ts).
    PORT    = { api = "3001", worker = "3002", notifications = "3003", webhooks = "3004" }[service]
    RELEASE = RELEASE
  }
  tags = ["${REGISTRY}/${service}:${TAG}"]
}

target "web" {
  inherits   = ["_common"]
  dockerfile = "deploy/docker/web.Dockerfile"
  tags       = ["${REGISTRY}/web:${TAG}"]
}

target "ai" {
  inherits   = ["_common"]
  dockerfile = "deploy/docker/ai.Dockerfile"
  tags       = ["${REGISTRY}/ai:${TAG}"]
}

target "migrate" {
  inherits   = ["_common"]
  dockerfile = "deploy/docker/migrate.Dockerfile"
  tags       = ["${REGISTRY}/migrate:${TAG}"]
}
