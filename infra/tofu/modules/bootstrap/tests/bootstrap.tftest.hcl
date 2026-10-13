# Against mocked Helm and Kubernetes APIs: Argo CD with its SOPS key, the GitOps bridge
# Secret and the root Application.

mock_provider "helm" {}
mock_provider "kubernetes" {}

variables {
  cluster_name = "production"
  environment  = "production"
  sops_age_key = "# public key: age1qqqq\nAGE-SECRET-KEY-1QQQQ\n"
  cluster_annotations = {
    domain       = "example.com"
    tls-email    = "ops@example.com"
    image-policy = "true"
  }
}

run "registers_the_cluster_for_the_applicationsets" {
  command = apply
  assert {
    condition = kubernetes_secret_v1.cluster.metadata[0].labels == tomap({
      "argocd.argoproj.io/secret-type" = "cluster"
      "boilerplate.dev/managed"        = "true"
      "boilerplate.dev/environment"    = "production"
    })
    error_message = "the platform and envs ApplicationSets select clusters by these labels"
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.metadata[0].annotations["boilerplate.dev/domain"] == "example.com" && kubernetes_secret_v1.cluster.metadata[0].annotations["boilerplate.dev/image-policy"] == "true"
    error_message = "cluster facts become boilerplate.dev/ annotations"
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.metadata[0].annotations["boilerplate.dev/environment"] == "production" && kubernetes_secret_v1.cluster.metadata[0].annotations["boilerplate.dev/observability"] == "false"
    error_message = "the platform config reads the environment and the opt-ins from annotations"
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.data.server == "https://kubernetes.default.svc"
    error_message = "Argo CD deploys to its own cluster"
  }
}

run "marks_the_cluster_that_hosts_previews" {
  command = apply
  variables {
    environment          = "staging"
    previews             = true
    sops_preview_age_key = "AGE-SECRET-KEY-1PPPP"
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.metadata[0].labels["boilerplate.dev/previews"] == "true"
    error_message = "the previews ApplicationSet selects clusters by this label"
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.metadata[0].annotations["boilerplate.dev/previews"] == "true"
    error_message = "the platform config reads it to add the preview listener"
  }
}

run "opts_into_observability" {
  command = apply
  variables {
    observability = true
  }
  assert {
    condition     = kubernetes_secret_v1.cluster.metadata[0].labels["boilerplate.dev/observability"] == "true" && kubernetes_secret_v1.cluster.metadata[0].annotations["boilerplate.dev/observability"] == "true"
    error_message = "the observability add-ons select clusters by this label"
  }
  assert {
    condition     = !contains(keys(kubernetes_secret_v1.cluster.metadata[0].labels), "boilerplate.dev/previews")
    error_message = "previews stay off unless asked for"
  }
}

run "installs_the_sops_key_for_argo_cd" {
  command = apply
  assert {
    condition     = kubernetes_secret_v1.sops_age.metadata[0].name == "sops-age" && kubernetes_secret_v1.sops_age.metadata[0].namespace == "argocd"
    error_message = "the repo server mounts the Secret sops-age in argocd"
  }
  assert {
    condition     = local.sops_keys["keys.txt"] == var.sops_age_key && kubernetes_secret_v1.sops_age.data_wo_revision == 1
    error_message = "the age identity under keys.txt"
  }
}

# Replacing an age key (deploy/README.md): OpenTofu can't see a write-only value change,
# so raising the version is what rewrites the Secret.
run "rewrites_the_keys_when_their_version_is_raised" {
  command = apply
  variables {
    sops_keys_version = 2
  }
  assert {
    condition     = kubernetes_secret_v1.sops_age.data_wo_revision == 2
    error_message = "a raised sops_keys_version writes the keys again"
  }
}

run "keeps_the_preview_key_apart" {
  command = apply
  variables {
    previews             = true
    sops_preview_age_key = "AGE-SECRET-KEY-1PPPP\n"
  }
  assert {
    condition     = local.sops_keys["preview.txt"] == var.sops_preview_age_key && local.sops_keys["keys.txt"] == var.sops_age_key
    error_message = "previews decrypt with their own key, under preview.txt"
  }
}

run "has_no_preview_key_without_previews" {
  command = apply
  assert {
    condition     = !contains(keys(local.sops_keys), "preview.txt")
    error_message = "only the cluster hosting previews holds their key"
  }
}

run "needs_the_preview_key_to_host_previews" {
  command = apply
  variables {
    previews = true
  }
  expect_failures = [kubernetes_secret_v1.sops_age]
}

# Pull request plans run without the age keys (infra.yml): planning needs neither, and
# shows no change to the Secret that holds them.
run "plans_without_the_age_keys" {
  command = plan
  variables {
    previews     = true
    sops_age_key = null
  }
}

run "needs_the_age_key_to_apply" {
  command = apply
  variables {
    sops_age_key = null
  }
  expect_failures = [kubernetes_secret_v1.sops_age]
}

run "configures_argo_cd" {
  command = apply
  assert {
    condition     = yamldecode(helm_release.argocd.values[0]).configs.params["applicationsetcontroller.enable.progressive.syncs"] == true
    error_message = "RollingSync (data before stack) needs progressive syncs"
  }
  assert {
    condition     = helm_release.argocd.values[1] == file("${path.module}/../../../../deploy/argocd/argo-cd-values.yaml")
    error_message = "the repository's Argo CD values come last, so they win"
  }
  assert {
    condition     = helm_release.argocd.namespace == "argocd"
    error_message = "Argo CD lives in argocd"
  }
}

run "creates_the_root_application_from_the_repo" {
  command = apply
  assert {
    condition     = yamldecode(helm_release.root.values[0]).applications.root.source.path == "deploy/argocd"
    error_message = "the root app is deploy/argocd/root.yaml"
  }
  assert {
    condition     = yamldecode(helm_release.root.values[0]).applications.root.namespace == "argocd"
    error_message = "the root app lives with Argo CD"
  }
}

run "rejects_unknown_environments" {
  command = plan
  variables {
    environment = "prod"
  }
  expect_failures = [var.environment]
}

run "rejects_a_key_that_isnt_an_age_identity" {
  command = plan
  variables {
    sops_age_key = "age1qqqq"
  }
  expect_failures = [var.sops_age_key]
}
