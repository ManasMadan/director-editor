output "argocd_namespace" {
  description = "The namespace Argo CD runs in."
  value       = helm_release.argocd.namespace
}

output "cluster_labels" {
  description = "How the ApplicationSets select this cluster."
  value       = kubernetes_secret_v1.cluster.metadata[0].labels
}

output "cluster_annotations" {
  description = "What the ApplicationSets see on this cluster."
  value       = kubernetes_secret_v1.cluster.metadata[0].annotations
}
