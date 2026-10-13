variable "environment" {
  description = "staging or production."
  type        = string
}

variable "domain" {
  description = "The DNS zone the environment's hosts are in, e.g. example.com."
  type        = string
}

variable "dns" {
  description = <<-EOT
    Where the zone's records live, and how certificates are validated:
      provider   cloudflare (the default: Cloudflare's DNS, with its proxy in front of
                 the site) or rfc2136 (a name server of your own that takes TSIG-signed
                 dynamic updates: BIND, Knot, PowerDNS; nothing in front of the cluster)
      rfc2136    with rfc2136: server (its address, reachable from here and from the
                 cluster), port, key_name and key_algorithm of the TSIG key; the key's
                 secret is dns_tsig_secret
  EOT
  type = object({
    provider = optional(string, "cloudflare")
    rfc2136 = optional(object({
      server        = string
      port          = optional(number, 53)
      key_name      = string
      key_algorithm = optional(string, "hmac-sha256")
    }))
  })
  default = {}
  validation {
    condition     = contains(["cloudflare", "rfc2136"], var.dns.provider)
    error_message = "dns.provider is cloudflare or rfc2136."
  }
  validation {
    condition     = (var.dns.provider == "rfc2136") == (var.dns.rfc2136 != null)
    error_message = "dns.rfc2136 (the name server and TSIG key) goes with dns.provider = \"rfc2136\", and only with it."
  }
}

variable "dns_tsig_secret" {
  description = "With RFC 2136 DNS: the TSIG key's secret, base64 (TF_VAR_dns_tsig_secret). Needed to apply, not to plan."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null
}

variable "site_host" {
  description = "The environment's public host, e.g. app.example.com (must match deploy/environments/<env>/stack.yaml)."
  type        = string
}

variable "cloudflare_account_id" {
  description = "The Cloudflare account (Cloudflare DNS only)."
  type        = string
  default     = null
  validation {
    condition     = var.dns.provider != "cloudflare" || var.cloudflare_account_id != null
    error_message = "Cloudflare DNS needs cloudflare_account_id."
  }
}

variable "tls_email" {
  description = "Where Let's Encrypt sends certificate expiry notices."
  type        = string
}

variable "previews" {
  description = "Host pull-request previews on this environment's cluster (normally staging)."
  type        = bool
  default     = false
}

variable "observability" {
  description = "Run Jaeger, Prometheus and Grafana on this cluster (off suits a small single node)."
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Where Alertmanager emails alerts (with observability = true). Required in production."
  type        = string
  default     = null
  validation {
    condition     = var.environment != "production" || var.alert_email != null
    error_message = "Production needs alert_email: an address alerts reach someone at."
  }
}

variable "managed_waf" {
  description = "Cloudflare's managed WAF rules on the zone (needs a Pro plan or higher; Cloudflare DNS only)."
  type        = bool
  default     = false
  validation {
    condition     = !var.managed_waf || var.dns.provider == "cloudflare"
    error_message = "managed_waf is Cloudflare's: it needs dns.provider = \"cloudflare\"."
  }
}

# ---------------------------------------------------------------------------- nodes

variable "nodes" {
  description = "The machines, by node name (see modules/k3s)."
  type = map(object({
    address         = string
    private_address = optional(string)
    user            = optional(string, "root")
    role            = optional(string, "server")
    labels          = optional(map(string), {})
    taints          = optional(list(string), [])
  }))
}

variable "ssh_private_key" {
  description = "The key OpenTofu installs k3s with (TF_VAR_ssh_private_key). Needed to apply, not to plan."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true
}

variable "install_over_ssh" {
  description = "Off when the machines are created with the cloud_init output instead (see the README)."
  type        = bool
  default     = true
}

variable "api_host" {
  description = "A DNS name or virtual IP in front of the servers for the Kubernetes API; defaults to the first server's address."
  type        = string
  default     = null
}

variable "flannel_backend" {
  description = "vxlan on a private network, wireguard-native when nodes reach each other over the internet."
  type        = string
  default     = "vxlan"
}

variable "origin_ips" {
  description = "Where Cloudflare sends the site's traffic; defaults to every node's address."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------- mail

variable "mail" {
  description = <<-EOT
    The mail server's DNS, or null until it's set up.
      node                the node it runs on (labelled boilerplate.dev/mail=true): its
                          address is the MX host's, and its reverse DNS must be the host
      host                default mail.<domain>
      ipv6                the node's IPv6 address, if it has one
      domain              the domain mail is sent from (default: the zone)
      dkim_selector, dkim_public_key, dkim_algorithm, dmarc_policy, dmarc_report_email
                          see modules/cloudflare
  EOT
  type = object({
    node               = string
    host               = optional(string)
    ipv6               = optional(string)
    domain             = optional(string)
    dkim_selector      = optional(string)
    dkim_public_key    = string
    dkim_algorithm     = optional(string)
    dmarc_policy       = optional(string)
    dmarc_report_email = string
  })
  default = null
  validation {
    condition     = var.mail == null || try(contains(keys(var.nodes), var.mail.node), false)
    error_message = "mail.node is one of the nodes."
  }
}

# ---------------------------------------------------------------------------- secrets

# The SSH and age keys are ephemeral: only an apply needs them, and they're never kept
# in the state or a saved plan (so pull request plans run without them).
variable "sops_age_key" {
  description = "The environment's age private key, for Argo CD to decrypt its SOPS secrets (TF_VAR_sops_age_key). Needed to apply, not to plan."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null
}

variable "sops_preview_age_key" {
  description = "With previews = true: the previews' own age private key (TF_VAR_sops_preview_age_key)."
  type        = string
  sensitive   = true
  ephemeral   = true
  default     = null
}

variable "sops_keys_version" {
  description = "Raise it to write new age keys to the cluster (see the rotate-secrets skill): OpenTofu can't see a write-only key change."
  type        = number
  default     = 1
}

variable "state_passphrase" {
  description = "Encrypts state and plans (TF_VAR_state_passphrase, at least 16 characters)."
  type        = string
  sensitive   = true
}
