output "records" {
  description = "Every DNS record this creates, as name, type and content (the same shape as modules/cloudflare's)."
  value = concat(
    flatten([for host, set in dns_a_record_set.this : [for ip in sort(tolist(set.addresses)) : { name = host, type = "A", content = ip, proxied = false }]]),
    flatten([for host, set in dns_aaaa_record_set.this : [for ip in sort(tolist(set.addresses)) : { name = host, type = "AAAA", content = ip, proxied = false }]]),
    [for set in dns_mx_record_set.mail : { name = local.mail_domain, type = "MX", content = var.mail.host, proxied = false }],
    [for key, set in dns_txt_record_set.mail : { name = local.txt[key].host, type = "TXT", content = "\"${local.txt[key].value}\"", proxied = false }],
  )
}
