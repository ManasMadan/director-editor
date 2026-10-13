terraform {
  required_version = ">= 1.11.0"

  # Remote state per environment, in any S3-compatible bucket outside the cluster:
  # `tofu init -backend-config=backend-<env>.hcl`.
  backend "s3" {}

  # State and plans hold the cluster's CAs, tokens and admin key, so they're encrypted
  # before they leave this machine; unencrypted state is refused. Keep the passphrase in
  # your password manager and pass it as TF_VAR_state_passphrase.
  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26"
    }
    dns = {
      source  = "hashicorp/dns"
      version = "~> 3.4"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.38"
    }
  }
}
