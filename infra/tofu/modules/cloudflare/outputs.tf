output "zone_id" {
  description = "The Cloudflare zone the records are in."
  value       = local.zone_id
}

output "dns_api_token" {
  description = "For cert-manager's DNS-01 challenges: encrypt it into the platform's SOPS secrets."
  sensitive   = true
  value       = cloudflare_api_token.dns.value
}

output "turnstile" {
  description = "The captcha's keys: the site key is public, the secret goes into the api's SOPS secrets."
  sensitive   = true
  value = var.turnstile ? {
    site_key   = cloudflare_turnstile_widget.captcha[0].sitekey
    secret_key = cloudflare_turnstile_widget.captcha[0].secret
  } : null
}

output "records" {
  description = "Every DNS record this creates, as name, type and content."
  value = [for record in concat(
    values(cloudflare_dns_record.site), values(cloudflare_dns_record.previews), values(cloudflare_dns_record.mail_host),
    cloudflare_dns_record.mx, cloudflare_dns_record.spf, cloudflare_dns_record.dkim, cloudflare_dns_record.dmarc,
  ) : { name = record.name, type = record.type, content = record.content, proxied = record.proxied }]
}
