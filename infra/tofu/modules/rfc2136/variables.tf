variable "zone_name" {
  description = "The DNS zone, served by your own name server (BIND, Knot, PowerDNS, ...) that accepts TSIG-signed dynamic updates, e.g. example.com."
  type        = string
}

variable "site_hosts" {
  description = "The environment's public hosts, pointed straight at the origins (no proxy in front)."
  type        = list(string)
}

variable "origin_ips" {
  description = "The nodes' public addresses (every node answers on 80/443 through k3s's ServiceLB)."
  type        = list(string)
  validation {
    condition     = length(var.origin_ips) > 0 && alltrue([for ip in var.origin_ips : can(cidrhost("${ip}/${strcontains(ip, ":") ? 128 : 32}", 0))])
    error_message = "At least one IPv4 or IPv6 address."
  }
}

variable "preview_host" {
  description = "The host pull-request previews run under (pr-<n>.<preview_host>); null elsewhere."
  type        = string
  default     = null
}

variable "mail" {
  description = "Records for the mail server, or null for none: the same fields as modules/cloudflare's."
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
}

variable "ttl" {
  description = "The records' TTL, in seconds."
  type        = number
  default     = 300
}
