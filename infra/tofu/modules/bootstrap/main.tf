# Hands the cluster to GitOps: installs Argo CD (with the age key it decrypts the
# repository's SOPS secrets with), registers the cluster with the facts the
# ApplicationSets read (labels and annotations on its Argo CD cluster Secret), and
# creates the root Application (deploy/argocd/root.yaml). Everything else, add-ons
# included, then comes from the repository.

locals {
  labels = merge(
    {
      "argocd.argoproj.io/secret-type" = "cluster"
      "boilerplate.dev/managed"        = "true"
      "boilerplate.dev/environment"    = var.environment
    },
    var.previews ? { "boilerplate.dev/previews" = "true" } : {},
    var.observability ? { "boilerplate.dev/observability" = "true" } : {},
  )
  annotations = merge(
    { for key, value in var.cluster_annotations : "boilerplate.dev/${key}" => value },
    {
      "boilerplate.dev/environment"   = var.environment
      "boilerplate.dev/previews"      = tostring(var.previews)
      "boilerplate.dev/observability" = tostring(var.observability)
    },
  )
  root = yamldecode(file("${path.module}/../../../../deploy/argocd/root.yaml"))
  sops_keys = merge(
    { "keys.txt" = var.sops_age_key },
    var.previews ? { "preview.txt" = var.sops_preview_age_key } : {},
  )
}

resource "kubernetes_namespace_v1" "argocd" {
  metadata {
    name = "argocd"
  }
}

# Before Argo CD, so its repo server starts with the key mounted.
resource "kubernetes_secret_v1" "sops_age" {
  metadata {
    name      = "sops-age"
    namespace = kubernetes_namespace_v1.argocd.metadata[0].name
  }
  data_wo          = local.sops_keys
  data_wo_revision = var.sops_keys_version
  lifecycle {
    precondition {
      condition     = !terraform.applying || var.sops_age_key != null
      error_message = "Applying writes the cluster's age key: set sops_age_key (TF_VAR_sops_age_key)."
    }
    precondition {
      condition     = !terraform.applying || !var.previews || strcontains(coalesce(var.sops_preview_age_key, "-"), "AGE-SECRET-KEY-1")
      error_message = "A cluster hosting previews needs their age key (sops_preview_age_key), separate from its own."
    }
  }
}

resource "helm_release" "argocd" {
  name       = "argocd"
  namespace  = kubernetes_namespace_v1.argocd.metadata[0].name
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = var.argocd_version
  wait       = true
  values = [
    yamlencode({
      configs = {
        params = {
          # The envs and previews ApplicationSets roll out data before stack.
          "applicationsetcontroller.enable.progressive.syncs" = true
        }
        cm = {
          # Sign-in through your identity provider is set up per organization (dex/OIDC).
          "admin.enabled" = true
        }
      }
      dex = { enabled = false }
    }),
    # The repository's own values (SOPS decryption in the repo server), applied last.
    file("${path.module}/../../../../deploy/argocd/argo-cd-values.yaml"),
  ]
  depends_on = [kubernetes_secret_v1.sops_age]
}

# In-cluster registration: Argo CD deploys to the cluster it runs in, and the
# ApplicationSets select it by these labels and read its annotations.
resource "kubernetes_secret_v1" "cluster" {
  metadata {
    name        = "cluster-${var.cluster_name}"
    namespace   = kubernetes_namespace_v1.argocd.metadata[0].name
    labels      = local.labels
    annotations = local.annotations
  }
  data = {
    name   = var.cluster_name
    server = "https://kubernetes.default.svc"
    config = jsonencode({ tlsClientConfig = { insecure = false } })
  }
}

resource "helm_release" "root" {
  name       = "argocd-root"
  namespace  = helm_release.argocd.namespace
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-apps"
  version    = var.argocd_apps_version
  values = [yamlencode({
    applications = {
      (local.root.metadata.name) = merge(local.root.spec, {
        namespace = local.root.metadata.namespace
        source    = merge(local.root.spec.source, { repoURL = var.repo_url })
      })
    }
  })]
  depends_on = [kubernetes_secret_v1.cluster]
}
