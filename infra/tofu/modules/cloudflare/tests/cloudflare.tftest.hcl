# Against a mocked Cloudflare API: the records each environment gets, and how tightly
# the token is scoped.

mock_provider "cloudflare" {
  override_data {
    target = data.cloudflare_zone.this
    values = { zone_id = "023e105f4ecef8ad9ca31a8372d0c353" }
  }
  override_data {
    target = data.cloudflare_api_token_permission_groups_list.this
    values = { result = [{ id = "perm-id", name = "permission", category = "Zone", is_selectable = true, scopes = [] }] }
  }
  mock_resource "cloudflare_api_token" {
    defaults = { id = "token-id", value = "token-value" }
  }
  mock_resource "cloudflare_turnstile_widget" {
    defaults = { sitekey = "site-key", secret = "secret-key" }
  }
}

variables {
  account_id = "01a7362d577a6c3019a474fd6f485823"
  zone_name  = "example.com"
  name       = "boilerplate-production"
  site_hosts = ["app.example.com"]
  origin_ips = ["203.0.113.10", "203.0.113.11"]
}

run "hardens_the_zone" {
  command = apply
  assert {
    condition     = cloudflare_zone_setting.this["ssl"].value == "strict" && cloudflare_zone_setting.this["always_use_https"].value == "on"
    error_message = "the zone must use strict TLS and HTTPS only"
  }
  assert {
    condition     = cloudflare_authenticated_origin_pulls_settings.this.enabled
    error_message = "Cloudflare must present its client certificate, which the gateway requires"
  }
  assert {
    condition     = length(cloudflare_ruleset.managed_waf) == 0
    error_message = "the managed WAF needs a paid plan, so it's opt-in"
  }
}

run "proxies_the_site_to_every_origin" {
  command = apply
  assert {
    condition     = toset([for record in cloudflare_dns_record.site : "${record.name} ${record.type} ${record.content}"]) == toset(["app.example.com A 203.0.113.10", "app.example.com A 203.0.113.11"])
    error_message = "one record per origin"
  }
  assert {
    condition     = alltrue([for record in cloudflare_dns_record.site : record.proxied])
    error_message = "the site goes through Cloudflare's proxy"
  }
  assert {
    condition     = length(cloudflare_dns_record.previews) == 0 && length(cloudflare_dns_record.mx) == 0 && length(cloudflare_dns_record.mail_host) == 0
    error_message = "no preview or mail records unless asked for"
  }
}

run "gives_ipv6_origins_aaaa_records" {
  command = apply
  variables {
    origin_ips = ["2001:db8::10"]
  }
  assert {
    condition     = cloudflare_dns_record.site["app.example.com 2001:db8::10"].type == "AAAA"
    error_message = "IPv6 origins are AAAA records"
  }
}

run "points_previews_at_the_cluster_without_the_proxy" {
  command = apply
  variables {
    preview_host = "preview.example.com"
  }
  assert {
    condition     = toset([for record in cloudflare_dns_record.previews : "${record.name} ${record.content}"]) == toset(["*.preview.example.com 203.0.113.10", "*.preview.example.com 203.0.113.11"])
    error_message = "a wildcard for pr-<n>.preview.example.com"
  }
  assert {
    condition     = alltrue([for record in cloudflare_dns_record.previews : !record.proxied])
    error_message = "the free edge certificate doesn't cover a second-level wildcard"
  }
  assert {
    condition     = cloudflare_turnstile_widget.captcha[0].domains == tolist(["app.example.com", "preview.example.com"])
    error_message = "the captcha runs on previews too"
  }
}

run "publishes_the_mail_records" {
  command = apply
  variables {
    mail = {
      host               = "mail.example.com"
      ipv4               = "203.0.113.20"
      ipv6               = "2001:db8::20"
      dkim_selector      = "stalwart"
      dkim_public_key    = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxKLxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo9z+40RQzuVaE8AkAFmxZzow3x+VJYKdx/I6WHlxCxzUuatTgjlT7Hc/0V9uMHXBV6tm6mz2RUg8CkWLGIJOxnnT+zwkRCaVzT/hCQ5Dl3dADFW3JLSa54fZ5ZTYUfcR9N5l0B3+6i89wYWmlnnBSMk7tkq8kCchDIFqfDQIDAQAB"
      dmarc_report_email = "dmarc@example.com"
    }
  }
  assert {
    condition     = toset([for record in cloudflare_dns_record.mail_host : "${record.name} ${record.type} ${record.content} ${record.proxied}"]) == toset(["mail.example.com A 203.0.113.20 false", "mail.example.com AAAA 2001:db8::20 false"])
    error_message = "the mail host is DNS only (SMTP can't go through the proxy)"
  }
  assert {
    condition     = cloudflare_dns_record.mx[0].name == "example.com" && cloudflare_dns_record.mx[0].content == "mail.example.com" && cloudflare_dns_record.mx[0].priority == 10
    error_message = "the zone's mail goes to the mail host"
  }
  assert {
    condition     = cloudflare_dns_record.spf[0].content == "\"v=spf1 ip6:2001:db8::20 ip4:203.0.113.20 -all\""
    error_message = "only the mail server's addresses may send"
  }
  assert {
    condition     = cloudflare_dns_record.dkim[0].name == "stalwart._domainkey.example.com" && startswith(cloudflare_dns_record.dkim[0].content, "\"v=DKIM1; k=rsa; p=MIIBIjAN")
    error_message = "the DKIM key under its selector"
  }
  assert {
    condition     = replace(cloudflare_dns_record.dkim[0].content, "\" \"", "") == "\"v=DKIM1; k=rsa; p=${var.mail.dkim_public_key}\"" && alltrue([for chunk in split("\" \"", trim(cloudflare_dns_record.dkim[0].content, "\"")) : length(chunk) <= 255])
    error_message = "a 2048-bit key is split into strings of at most 255 characters"
  }
  assert {
    condition     = cloudflare_dns_record.dmarc[0].name == "_dmarc.example.com" && cloudflare_dns_record.dmarc[0].content == "\"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; adkim=s; aspf=s\""
    error_message = "DMARC with reports"
  }
  assert {
    condition     = length(output.records) == 8 && length([for record in output.records : record if record.type == "TXT"]) == 3
    error_message = "the records output lists the site's and the mail records"
  }
}

run "sends_mail_for_another_domain" {
  command = apply
  variables {
    mail = {
      host               = "mail.example.com"
      ipv4               = "203.0.113.20"
      domain             = "notify.example.com"
      dkim_public_key    = "MCowBQYDK2VwAyEA"
      dkim_algorithm     = "ed25519"
      dmarc_policy       = "reject"
      dmarc_report_email = "dmarc@example.com"
    }
  }
  assert {
    condition     = cloudflare_dns_record.mx[0].name == "notify.example.com" && cloudflare_dns_record.dkim[0].name == "default._domainkey.notify.example.com"
    error_message = "the records go on the mail domain"
  }
  assert {
    condition     = cloudflare_dns_record.dkim[0].content == "\"v=DKIM1; k=ed25519; p=MCowBQYDK2VwAyEA\"" && strcontains(cloudflare_dns_record.dmarc[0].content, "p=reject;")
    error_message = "ed25519 key, reject policy"
  }
}

run "scopes_the_token_to_the_zone" {
  command = apply
  assert {
    condition     = jsondecode(cloudflare_api_token.dns.policies[0].resources) == { "com.cloudflare.api.account.zone.023e105f4ecef8ad9ca31a8372d0c353" = "*" }
    error_message = "the DNS token must cover this zone only"
  }
  assert {
    condition     = output.dns_api_token == "token-value" && output.turnstile.site_key == "site-key"
    error_message = "token and Turnstile keys"
  }
}

run "can_skip_the_captcha_and_add_the_waf" {
  command = apply
  variables {
    turnstile   = false
    managed_waf = true
  }
  assert {
    condition     = output.turnstile == null && length(cloudflare_ruleset.managed_waf) == 1
    error_message = "optional parts"
  }
}

run "rejects_origins_that_arent_addresses" {
  command = plan
  variables {
    origin_ips = ["node-1.example.com"]
  }
  expect_failures = [var.origin_ips]
}

run "rejects_a_pem_dkim_key" {
  command = plan
  variables {
    mail = {
      host               = "mail.example.com"
      ipv4               = "203.0.113.20"
      dkim_public_key    = "-----BEGIN PUBLIC KEY-----"
      dmarc_report_email = "dmarc@example.com"
    }
  }
  expect_failures = [var.mail]
}

run "rejects_unknown_dmarc_policies" {
  command = plan
  variables {
    mail = {
      host               = "mail.example.com"
      ipv4               = "203.0.113.20"
      dkim_public_key    = "MCowBQYDK2VwAyEA"
      dmarc_policy       = "strict"
      dmarc_report_email = "dmarc@example.com"
    }
  }
  expect_failures = [var.mail]
}
