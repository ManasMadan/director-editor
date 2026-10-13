output "api_url" {
  description = "The address of the cluster's Kubernetes API."
  value       = module.k3s.api_url
}

output "kubeconfig" {
  description = "tofu output -raw kubeconfig > ~/.kube/boilerplate-<env>"
  sensitive   = true
  value       = module.k3s.kubeconfig
}

output "cloud_init" {
  description = "User data per node, with install_over_ssh = false."
  sensitive   = true
  value       = module.k3s.cloud_init
}

output "dns_records" {
  description = "Every DNS record the environment creates, as name, type and content."
  value       = flatten(concat(module.cloudflare[*].records, module.rfc2136[*].records))
}

output "cloudflare_dns_api_token" {
  description = "For cert-manager's DNS-01 challenges: encrypt it into the platform's SOPS secrets (Cloudflare DNS only)."
  sensitive   = true
  value       = one(module.cloudflare[*].dns_api_token)
}

output "turnstile" {
  description = "The captcha's site key and secret, for the api's SOPS secrets (Cloudflare only)."
  sensitive   = true
  value       = one(module.cloudflare[*].turnstile)
}
