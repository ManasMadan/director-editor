# The environment's DNS on a name server of your own, through RFC 2136 dynamic updates
# signed with a TSIG key: the same records modules/cloudflare publishes, with nothing in
# front of the cluster (clients connect to the nodes, so the gateway trusts no proxy).
# The provider's server and key are the root's (envs/k3s, `dns`).
#
# Each record here is a whole record set: a name this manages (the zone's apex TXT for
# SPF, for one) holds only what's below, so put anything else at those names here too.

locals {
  zone = "${trimsuffix(var.zone_name, ".")}."
  # A host relative to the zone: the apex is the zone itself.
  relative = { for host in compact(concat(var.site_hosts, [var.preview_host == null ? null : "*.${var.preview_host}"], [try(var.mail.host, null)], [try(coalesce(var.mail.domain, var.zone_name), null)])) :
    host => host == var.zone_name ? null : trimsuffix(host, ".${var.zone_name}")
  }
  ipv4 = [for ip in var.origin_ips : ip if !strcontains(ip, ":")]
  ipv6 = [for ip in var.origin_ips : ip if strcontains(ip, ":")]

  hosts = merge(
    { for host in var.site_hosts : host => { ipv4 = local.ipv4, ipv6 = local.ipv6 } },
    var.preview_host == null ? {} : { "*.${var.preview_host}" = { ipv4 = local.ipv4, ipv6 = local.ipv6 } },
    var.mail == null ? {} : { (var.mail.host) = { ipv4 = [var.mail.ipv4], ipv6 = compact([var.mail.ipv6]) } },
  )
  mail_domain = var.mail == null ? null : coalesce(var.mail.domain, var.zone_name)
  mail_ips    = var.mail == null ? [] : compact([var.mail.ipv4, var.mail.ipv6])
  txt = var.mail == null ? {} : {
    spf   = { host = local.mail_domain, value = join(" ", concat(["v=spf1"], [for ip in local.mail_ips : "${strcontains(ip, ":") ? "ip6" : "ip4"}:${ip}"], ["-all"])) }
    dkim  = { host = "${var.mail.dkim_selector}._domainkey.${local.mail_domain}", value = "v=DKIM1; k=${var.mail.dkim_algorithm}; p=${var.mail.dkim_public_key}" }
    dmarc = { host = "_dmarc.${local.mail_domain}", value = "v=DMARC1; p=${var.mail.dmarc_policy}; rua=mailto:${var.mail.dmarc_report_email}; adkim=s; aspf=s" }
  }
}

resource "dns_a_record_set" "this" {
  for_each  = { for host, ips in local.hosts : host => ips.ipv4 if length(ips.ipv4) > 0 }
  zone      = local.zone
  name      = local.relative[each.key]
  addresses = each.value
  ttl       = var.ttl
}

resource "dns_aaaa_record_set" "this" {
  for_each  = { for host, ips in local.hosts : host => ips.ipv6 if length(ips.ipv6) > 0 }
  zone      = local.zone
  name      = local.relative[each.key]
  addresses = each.value
  ttl       = var.ttl
}

resource "dns_mx_record_set" "mail" {
  count = var.mail == null ? 0 : 1
  zone  = local.zone
  name  = local.relative[local.mail_domain]
  mx {
    preference = 10
    exchange   = "${var.mail.host}."
  }
  ttl = var.ttl
}

# The provider splits a value longer than one TXT string (a 2048-bit DKIM key) itself.
resource "dns_txt_record_set" "mail" {
  for_each = local.txt
  zone     = local.zone
  name     = each.value.host == var.zone_name ? null : trimsuffix(each.value.host, ".${var.zone_name}")
  txt      = [each.value.value]
  ttl      = var.ttl
}
