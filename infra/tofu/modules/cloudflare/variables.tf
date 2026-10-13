variable "account_id" {
  description = "The Cloudflare account."
  type        = string
}

variable "zone_name" {
  description = "The DNS zone (already on Cloudflare), e.g. example.com."
  type        = string
}

variable "name" {
  description = "Name for this environment's resources, e.g. boilerplate-production."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,40}$", var.name))
    error_message = "Lowercase letters, digits and dashes."
  }
}

variable "site_hosts" {
  description = "The environment's public hosts, proxied by Cloudflare to the origins (the captcha runs on them too)."
  type        = list(string)
}

variable "origin_ips" {
  description = "Where Cloudflare sends the site's traffic: the nodes' public addresses (every node answers on 80/443 through k3s's ServiceLB)."
  type        = list(string)
  validation {
    condition     = length(var.origin_ips) > 0 && alltrue([for ip in var.origin_ips : can(cidrhost("${ip}/${strcontains(ip, ":") ? 128 : 32}", 0))])
    error_message = "At least one IPv4 or IPv6 address."
  }
}

variable "preview_host" {
  description = "The host pull-request previews run under (pr-<n>.<preview_host>), on the cluster that hosts them; null elsewhere."
  type        = string
  default     = null
}

variable "mail" {
  description = <<-EOT
    Records for the mail server, or null for none.
      host                the mail server's name, e.g. mail.example.com (its reverse DNS
                          must match: set it where the address comes from)
      ipv4, ipv6          its public addresses (the node it runs on)
      domain              the domain mail is sent from and received for (default: the zone)
      dkim_selector       the selector the mail server signs with
      dkim_public_key     the public key, base64 (the p= value)
      dkim_algorithm      rsa or ed25519
      dmarc_policy        none, quarantine or reject
      dmarc_report_email  where receivers send DMARC reports
  EOT
  type = object({
    host               = string
    ipv4               = string
    ipv6               = optional(string)
    domain             = optional(string)
    dkim_selector      = optional(string, "default")
    dkim_public_key    = string
    dkim_algorithm     = optional(string, "rsa")
    dmarc_policy       = optional(string, "quarantine")
    dmarc_report_email = string
  })
  default = null

  validation {
    condition     = var.mail == null || can(cidrnetmask("${var.mail.ipv4}/32"))
    error_message = "mail.ipv4 is an IPv4 address."
  }
  validation {
    condition     = var.mail == null || try(var.mail.ipv6 == null || can(cidrhost("${var.mail.ipv6}/128", 0)), false)
    error_message = "mail.ipv6 is an IPv6 address."
  }
  validation {
    condition     = var.mail == null || try(contains(["rsa", "ed25519"], var.mail.dkim_algorithm) && can(regex("^[A-Za-z0-9+/]+=*$", var.mail.dkim_public_key)), false)
    error_message = "mail.dkim_algorithm is rsa or ed25519, and mail.dkim_public_key the key's base64 alone (no PEM header, no spaces)."
  }
  validation {
    condition     = var.mail == null || try(contains(["none", "quarantine", "reject"], var.mail.dmarc_policy), false)
    error_message = "mail.dmarc_policy is none, quarantine or reject."
  }
}

variable "turnstile" {
  description = "Create a Turnstile widget for the sign-up and sign-in captcha."
  type        = bool
  default     = true
}

variable "managed_waf" {
  description = "Run Cloudflare's managed WAF rules on the zone (needs a Pro plan or higher)."
  type        = bool
  default     = false
}
