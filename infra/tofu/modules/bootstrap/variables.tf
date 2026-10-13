variable "cluster_name" {
  description = "The cluster's name in Argo CD (e.g. production)."
  type        = string
}

variable "environment" {
  description = "What the cluster runs: staging or production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "staging or production."
  }
}

variable "previews" {
  description = "Run pull-request previews on this cluster too (normally staging's)."
  type        = bool
  default     = false
}

variable "observability" {
  description = "Run the observability add-ons (Jaeger, Prometheus, Grafana) on this cluster."
  type        = bool
  default     = false
}

variable "cluster_annotations" {
  description = "Facts about the cluster for the platform ApplicationSet (boilerplate.dev/<key>): domain, TLS email and the like."
  type        = map(string)
  default     = {}
}

# The age keys are ephemeral and written to the cluster as write-only data: they're in
# neither the state nor a saved plan, and a plan doesn't need them (only an apply does),
# so pull request plans run without them.
variable "sops_age_key" {
  description = "The age private key (a keys.txt) Argo CD decrypts the environment's SOPS secrets with. Needed to apply, not to plan."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null
  validation {
    condition     = var.sops_age_key == null || strcontains(coalesce(var.sops_age_key, "-"), "AGE-SECRET-KEY-1")
    error_message = "An age identity file: a line starting with AGE-SECRET-KEY-1 (age-keygen's output)."
  }
}

variable "sops_preview_age_key" {
  description = "On the cluster hosting previews, the age private key they decrypt their SOPS secrets with alone (never the cluster's own)."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null
}

variable "sops_keys_version" {
  description = "Raise it to write new age keys to the cluster: they're write-only, so OpenTofu can't see that they changed."
  type        = number
  default     = 1
}

variable "repo_url" {
  description = "The Git repository Argo CD deploys from."
  type        = string
  default     = "https://github.com/ManasMadan/boilerplate.git"
}

variable "argocd_version" {
  description = "The argo-cd Helm chart version."
  type        = string
  # renovate: datasource=helm depName=argo-cd registryUrl=https://argoproj.github.io/argo-helm
  default = "10.9.2"
}

variable "argocd_apps_version" {
  description = "The argocd-apps Helm chart version (creates the root Application)."
  type        = string
  # renovate: datasource=helm depName=argocd-apps registryUrl=https://argoproj.github.io/argo-helm
  default = "2.0.5"
}
