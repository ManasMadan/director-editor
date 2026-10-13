# Against a mocked name server: the records an environment gets on DNS of its own.

mock_provider "dns" {}

variables {
  zone_name  = "example.com"
  site_hosts = ["app.example.com"]
  origin_ips = ["203.0.113.10", "2001:db8::10"]
}

run "points_the_site_at_every_origin" {
  command = apply
  assert {
    condition     = dns_a_record_set.this["app.example.com"].zone == "example.com." && dns_a_record_set.this["app.example.com"].name == "app"
    error_message = "names are relative to the zone, which ends in a dot"
  }
  assert {
    condition = toset([for r in output.records : "${r.name} ${r.type} ${r.content} ${r.proxied}"]) == toset([
      "app.example.com A 203.0.113.10 false",
      "app.example.com AAAA 2001:db8::10 false",
    ])
    error_message = "the site on each address, unproxied, and nothing else unless asked"
  }
}

run "serves_the_apex_and_previews" {
  command = apply
  variables {
    site_hosts   = ["example.com"]
    origin_ips   = ["203.0.113.10"]
    preview_host = "preview.example.com"
  }
  assert {
    condition     = dns_a_record_set.this["example.com"].name == null && dns_a_record_set.this["*.preview.example.com"].name == "*.preview"
    error_message = "the apex has no name; previews are a wildcard under the preview host"
  }
}

run "publishes_the_mail_records" {
  command = apply
  variables {
    origin_ips = ["203.0.113.10"]
    mail = {
      host               = "mail.example.com"
      ipv4               = "203.0.113.20"
      dkim_public_key    = "MCowBQYDK2VwAyEA"
      dmarc_report_email = "dmarc@example.com"
    }
  }
  assert {
    condition = toset([for r in output.records : "${r.name} ${r.type} ${r.content}" if r.name != "app.example.com"]) == toset([
      "mail.example.com A 203.0.113.20",
      "example.com MX mail.example.com",
      "example.com TXT \"v=spf1 ip4:203.0.113.20 -all\"",
      "default._domainkey.example.com TXT \"v=DKIM1; k=rsa; p=MCowBQYDK2VwAyEA\"",
      "_dmarc.example.com TXT \"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; adkim=s; aspf=s\"",
    ])
    error_message = "the same mail records as on Cloudflare"
  }
  assert {
    condition     = one(dns_mx_record_set.mail).name == null && one(one(dns_mx_record_set.mail).mx).exchange == "mail.example.com."
    error_message = "MX at the apex, naming the mail host absolutely"
  }
}
