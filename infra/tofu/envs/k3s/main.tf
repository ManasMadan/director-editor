# One environment: k3s on your machines, its DNS (Cloudflare in front by default, or a
# name server of your own: `dns`), and the cluster handed to Argo CD, which deploys the
# rest from this repository. Staging and production are this same root with their own
# tfvars and state.
#
#   tofu init -backend-config=backend-staging.hcl
#   tofu apply -var-file=staging.tfvars
#
# Credentials come from the environment: CLOUDFLARE_API_TOKEN (see modules/cloudflare
# for its permissions) or, with RFC 2136 DNS, TF_VAR_dns_tsig_secret;
# TF_VAR_ssh_private_key, TF_VAR_sops_age_key (and TF_VAR_sops_preview_age_key where
# previews run) and TF_VAR_state_passphrase.

locals {
  name = "boilerplate-${var.environment}"

  # The mail server runs on the node that its DNS points at (outgoing mail leaves from
  # the address of the node it's sent from, which SPF and reverse DNS vouch for).
  nodes = { for name, node in var.nodes : name => merge(node, {
    labels = merge(node.labels, var.mail != null && try(var.mail.node == name, false) ? { "boilerplate.dev/mail" = "true" } : {})
  }) }
  mail_host = var.mail == null ? null : coalesce(var.mail.host, "mail.${var.domain}")

  # Cloudflare proxies the site, so the gateway trusts one hop of X-Forwarded-For and
  # only Cloudflare's client certificate; with DNS of its own, clients connect directly.
  cloudflare = var.dns.provider == "cloudflare"
  records = {
    zone_name    = var.domain
    site_hosts   = [var.site_host]
    origin_ips   = length(var.origin_ips) > 0 ? var.origin_ips : [for node in var.nodes : node.address]
    preview_host = var.previews ? "preview.${var.domain}" : null
    mail = var.mail == null ? null : {
      host               = local.mail_host
      ipv4               = var.nodes[var.mail.node].address
      ipv6               = var.mail.ipv6
      domain             = var.mail.domain
      dkim_selector      = var.mail.dkim_selector
      dkim_public_key    = var.mail.dkim_public_key
      dkim_algorithm     = var.mail.dkim_algorithm
      dmarc_policy       = var.mail.dmarc_policy
      dmarc_report_email = var.mail.dmarc_report_email
    }
  }
}

# Only the one `dns` names is configured: the other has no resources.
provider "cloudflare" {}

provider "dns" {
  update {
    server        = try(var.dns.rfc2136.server, null)
    port          = try(var.dns.rfc2136.port, null)
    key_name      = try("${trimsuffix(var.dns.rfc2136.key_name, ".")}.", null)
    key_algorithm = try(var.dns.rfc2136.key_algorithm, null)
    key_secret    = var.dns_tsig_secret
  }
}

provider "helm" {
  kubernetes = module.k3s.kubernetes
}

provider "kubernetes" {
  host                   = module.k3s.kubernetes.host
  cluster_ca_certificate = module.k3s.kubernetes.cluster_ca_certificate
  client_certificate     = module.k3s.kubernetes.client_certificate
  client_key             = module.k3s.kubernetes.client_key
}

module "k3s" {
  source           = "../../modules/k3s"
  name             = local.name
  nodes            = local.nodes
  ssh_private_key  = var.ssh_private_key
  install_over_ssh = var.install_over_ssh
  api_host         = var.api_host
  flannel_backend  = var.flannel_backend
}

module "cloudflare" {
  count        = local.cloudflare ? 1 : 0
  source       = "../../modules/cloudflare"
  account_id   = var.cloudflare_account_id
  name         = local.name
  managed_waf  = var.managed_waf
  zone_name    = local.records.zone_name
  site_hosts   = local.records.site_hosts
  origin_ips   = local.records.origin_ips
  preview_host = local.records.preview_host
  mail         = local.records.mail
}

# State written before the provider was a choice has the module without an index: the
# same resources, so an existing environment plans no change.
moved {
  from = module.cloudflare
  to   = module.cloudflare[0]
}

module "rfc2136" {
  count        = var.dns.provider == "rfc2136" ? 1 : 0
  source       = "../../modules/rfc2136"
  zone_name    = local.records.zone_name
  site_hosts   = local.records.site_hosts
  origin_ips   = local.records.origin_ips
  preview_host = local.records.preview_host
  mail         = local.records.mail
}

module "bootstrap" {
  source        = "../../modules/bootstrap"
  cluster_name  = var.environment
  environment   = var.environment
  previews      = var.previews
  observability = var.observability
  sops_age_key  = var.sops_age_key

  sops_preview_age_key = var.sops_preview_age_key
  sops_keys_version    = var.sops_keys_version
  cluster_annotations = merge(
    {
      domain         = var.domain
      "tls-email"    = var.tls_email
      "image-policy" = tostring(var.environment == "production")
    },
    # How the platform reaches the DNS: cert-manager's DNS-01 solver and external-dns
    # (deploy/platform/addons), and what the gateway trusts.
    {
      "dns-provider" = var.dns.provider
      "trusted-hops" = local.cloudflare ? "1" : "0"
      "origin-pulls" = tostring(local.cloudflare)
    },
    var.dns.rfc2136 == null ? {} : {
      "dns-nameserver"     = "${var.dns.rfc2136.server}:${var.dns.rfc2136.port}"
      "dns-tsig-key-name"  = var.dns.rfc2136.key_name
      "dns-tsig-algorithm" = var.dns.rfc2136.key_algorithm
    },
    local.mail_host == null ? {} : { "mail-host" = local.mail_host },
    try(var.mail.domain, null) == null ? {} : { "mail-domain" = var.mail.domain },
    var.alert_email == null ? {} : { "alert-email" = var.alert_email },
  )
  # Argo CD goes on once every node is installed.
  depends_on = [module.k3s]
}
