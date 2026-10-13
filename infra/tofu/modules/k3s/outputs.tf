output "api_url" {
  description = "The address of the cluster's Kubernetes API."
  value       = local.api_url
}

output "kubernetes" {
  description = "Admin credentials for the helm and kubernetes providers."
  sensitive   = true
  value = {
    host                   = local.api_url
    cluster_ca_certificate = tls_self_signed_cert.ca["server-ca"].cert_pem
    client_certificate     = tls_locally_signed_cert.admin.cert_pem
    client_key             = tls_private_key.admin.private_key_pem
  }
}

output "kubeconfig" {
  description = "The same credentials as a kubeconfig (tofu output -raw kubeconfig > ~/.kube/<name>)."
  sensitive   = true
  value = yamlencode({
    apiVersion = "v1"
    kind       = "Config"
    clusters = [{
      name    = var.name
      cluster = { server = local.api_url, "certificate-authority-data" = base64encode(tls_self_signed_cert.ca["server-ca"].cert_pem) }
    }]
    users = [{
      name = "${var.name}-admin"
      user = {
        "client-certificate-data" = base64encode(tls_locally_signed_cert.admin.cert_pem)
        "client-key-data"         = base64encode(tls_private_key.admin.private_key_pem)
      }
    }]
    contexts          = [{ name = var.name, context = { cluster = var.name, user = "${var.name}-admin" } }]
    "current-context" = var.name
  })
}

output "cloud_init" {
  description = "User data per node, for machines created with cloud-init instead of installed over SSH: the same k3s configuration and installer."
  sensitive   = true
  value       = local.cloud_init
}
