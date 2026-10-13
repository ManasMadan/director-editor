# Cloudflare in front of an environment: the zone's TLS settings (and optionally the
# managed WAF), the site's DNS records (proxied, so the WAF and CDN sit in front of the
# cluster), the mail records for the in-cluster mail server, a token that can only edit
# this zone's DNS (cert-manager's DNS-01 challenges), and the Turnstile widget.
#
# The provider's own token needs: Zone Settings Edit, Zone WAF Edit (for managed_waf),
# DNS Edit, SSL and Certificates Edit (origin pulls), Turnstile Sites Write, and API
# Tokens Write (to create the scoped token). A token that only plans (pull requests,
# .github/workflows/infra.yml) needs the Read of each instead.

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

locals {
  zone_id = data.cloudflare_zone.this.zone_id
  type    = { for ip in var.origin_ips : ip => strcontains(ip, ":") ? "AAAA" : "A" }
}

# Full (strict) TLS to the origin, HTTPS only, modern TLS.
resource "cloudflare_zone_setting" "this" {
  for_each = {
    ssl              = "strict"
    always_use_https = "on"
    min_tls_version  = "1.2"
  }
  zone_id    = local.zone_id
  setting_id = each.key
  value      = each.value
}

# Cloudflare presents its origin-pull client certificate to the cluster, and the gateway
# (deploy/platform/config) refuses the site's hosts to anything that doesn't: someone
# who finds a node's address can't skip Cloudflare and forge X-Forwarded-For. Apply this
# before the gateway requires it, or the site is refused in between.
resource "cloudflare_authenticated_origin_pulls_settings" "this" {
  zone_id = local.zone_id
  enabled = true
}

resource "cloudflare_ruleset" "managed_waf" {
  count   = var.managed_waf ? 1 : 0
  zone_id = local.zone_id
  name    = "Managed WAF"
  kind    = "zone"
  phase   = "http_request_firewall_managed"
  rules = [{
    action      = "execute"
    expression  = "true"
    description = "Cloudflare Managed Ruleset"
    action_parameters = {
      # Cloudflare's published id for its Managed Ruleset.
      id = "efb7b8c949ac4650a09736fc376e9aee"
    }
  }]
}

# ------------------------------------------------------------------ the site

# Every site host on every origin (Cloudflare balances between records of one name).
resource "cloudflare_dns_record" "site" {
  for_each = { for pair in setproduct(var.site_hosts, var.origin_ips) : "${pair[0]} ${pair[1]}" => { name = pair[0], ip = pair[1] } }
  zone_id  = local.zone_id
  name     = each.value.name
  type     = local.type[each.value.ip]
  content  = each.value.ip
  proxied  = true
  ttl      = 1
  comment  = "${var.name}: the site"
}

# Pull-request previews at pr-<n>.<preview_host>. DNS only: Cloudflare's free edge
# certificate covers one level of subdomain, so the gateway serves these with its own
# wildcard certificate.
resource "cloudflare_dns_record" "previews" {
  for_each = var.preview_host == null ? toset([]) : toset(var.origin_ips)
  zone_id  = local.zone_id
  name     = "*.${var.preview_host}"
  type     = local.type[each.key]
  content  = each.key
  proxied  = false
  ttl      = 300
  comment  = "${var.name}: pull-request previews"
}

# ------------------------------------------------------------------ mail
#
# The mail server's host is DNS only (SMTP and IMAP can't go through Cloudflare's
# proxy). Its reverse DNS (PTR) must name the same host; that's set at the provider the
# address belongs to, not here.

locals {
  mail        = var.mail == null ? 0 : 1
  mail_domain = var.mail == null ? null : coalesce(var.mail.domain, var.zone_name)
  mail_ips    = var.mail == null ? {} : { for ip in compact([var.mail.ipv4, var.mail.ipv6]) : ip => strcontains(ip, ":") ? "AAAA" : "A" }
}

resource "cloudflare_dns_record" "mail_host" {
  for_each = local.mail_ips
  zone_id  = local.zone_id
  name     = var.mail.host
  type     = each.value
  content  = each.key
  proxied  = false
  ttl      = 300
  comment  = "${var.name}: the mail server"
}

resource "cloudflare_dns_record" "mx" {
  count    = local.mail
  zone_id  = local.zone_id
  name     = local.mail_domain
  type     = "MX"
  content  = var.mail.host
  priority = 10
  ttl      = 300
  comment  = "${var.name}: mail for ${local.mail_domain}"
}

# Only the mail server sends for the domain.
resource "cloudflare_dns_record" "spf" {
  count   = local.mail
  zone_id = local.zone_id
  name    = local.mail_domain
  type    = "TXT"
  content = "\"${join(" ", concat(["v=spf1"], [for ip, type in local.mail_ips : "${type == "A" ? "ip4" : "ip6"}:${ip}"], ["-all"]))}\""
  ttl     = 300
  comment = "${var.name}: SPF"
}

# The public half of the mail server's signing key (the private half is a SOPS secret).
# A 2048-bit RSA key is longer than one TXT string (255 characters), so it's split.
resource "cloudflare_dns_record" "dkim" {
  count   = local.mail
  zone_id = local.zone_id
  name    = "${var.mail.dkim_selector}._domainkey.${local.mail_domain}"
  type    = "TXT"
  content = join(" ", [for chunk in regexall(".{1,255}", "v=DKIM1; k=${var.mail.dkim_algorithm}; p=${var.mail.dkim_public_key}") : "\"${chunk}\""])
  ttl     = 300
  comment = "${var.name}: DKIM"
}

resource "cloudflare_dns_record" "dmarc" {
  count   = local.mail
  zone_id = local.zone_id
  name    = "_dmarc.${local.mail_domain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=${var.mail.dmarc_policy}; rua=mailto:${var.mail.dmarc_report_email}; adkim=s; aspf=s\""
  ttl     = 300
  comment = "${var.name}: DMARC"
}

# ------------------------------------------------------------------ tokens, captcha

data "cloudflare_api_token_permission_groups_list" "this" {
  for_each = toset(["Zone Read", "DNS Write"])
  name     = each.key
}

locals {
  permission = { for name, groups in data.cloudflare_api_token_permission_groups_list.this : name => one(groups.result).id }
}

# cert-manager (DNS-01 for the gateway's wildcard certificates): this zone's DNS
# records, nothing else.
resource "cloudflare_api_token" "dns" {
  name = "${var.name}-dns"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = local.permission["Zone Read"] }, { id = local.permission["DNS Write"] }]
    resources         = jsonencode({ "com.cloudflare.api.account.zone.${local.zone_id}" = "*" })
  }]
}

resource "cloudflare_turnstile_widget" "captcha" {
  count      = var.turnstile ? 1 : 0
  account_id = var.account_id
  name       = var.name
  domains    = compact(concat(var.site_hosts, [var.preview_host]))
  mode       = "managed"
}
