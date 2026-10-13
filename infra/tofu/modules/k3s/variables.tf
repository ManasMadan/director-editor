variable "name" {
  description = "The cluster's name in the kubeconfig, e.g. boilerplate-production."
  type        = string
}

variable "nodes" {
  description = <<-EOT
    The machines, by node name. The name is the node's identity in the cluster: keep it
    when you replace the machine behind it. The first server by name bootstraps the
    cluster, so name servers in the order you add them (server-1, server-2, …).
      address          public IPv4: OpenTofu connects to it over SSH, DNS points at it
      private_address  IP on a private network between the nodes, for cluster traffic
      user             SSH user (root, or one with passwordless sudo)
      role             server (the default: control plane, runs workloads too) or agent
      labels, taints   node labels and taints (key=value:NoSchedule)
  EOT
  type = map(object({
    address         = string
    private_address = optional(string)
    user            = optional(string, "root")
    role            = optional(string, "server")
    labels          = optional(map(string), {})
    taints          = optional(list(string), [])
  }))

  validation {
    condition     = alltrue([for node in var.nodes : contains(["server", "agent"], node.role)])
    error_message = "role is server or agent."
  }
  validation {
    condition     = anytrue([for node in var.nodes : node.role == "server"])
    error_message = "A cluster needs at least one server."
  }
  validation {
    condition     = alltrue([for name in keys(var.nodes) : can(regex("^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$", name))])
    error_message = "Node names are lowercase letters, digits, dots and dashes (they're Kubernetes node names)."
  }
  validation {
    condition = alltrue(flatten([for node in var.nodes : [
      for ip in compact([node.address, node.private_address]) : can(cidrnetmask("${ip}/32"))
    ]]))
    # k3s on IPv6 needs its own cluster and service CIDRs; the site can still get AAAA
    # records (the cloudflare module's origin_ips).
    error_message = "address and private_address are IPv4 addresses."
  }
  validation {
    condition = alltrue(flatten([for node in var.nodes : [
      for taint in node.taints : can(regex("^[^=:\\s]+(=[^:\\s]*)?:(NoSchedule|PreferNoSchedule|NoExecute)$", taint))
    ]]))
    error_message = "Taints look like key=value:NoSchedule (or PreferNoSchedule, NoExecute)."
  }
}

# Ephemeral: it's only used to connect while applying, so it's in neither the state nor
# a saved plan, and a plan doesn't need it.
variable "ssh_private_key" {
  description = "The private key OpenTofu connects to the nodes with (unused with install_over_ssh = false). Needed to apply, not to plan."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true
}

variable "install_over_ssh" {
  description = "Install k3s over SSH. Turn off when the machines are created with the cloud_init output as their user data instead."
  type        = bool
  default     = true
}

variable "k3s_version" {
  description = "The k3s release on every node. Changing it upgrades the nodes in place: the first server, then the other servers, then the agents."
  type        = string
  # renovate: datasource=github-releases depName=k3s-io/k3s
  default = "v1.36.4+k3s1"
  validation {
    condition     = can(regex("^v\\d+\\.\\d+\\.\\d+\\+k3s\\d+$", var.k3s_version))
    error_message = "A k3s release tag, e.g. v1.36.4+k3s1."
  }
}

variable "installer" {
  description = "The k3s install script: pinned by content, since it runs as root. It installs any k3s version and checks the binary against the release's checksums. To update it, download install.sh from a newer tag and put its SHA-256 here."
  type = object({
    url    = string
    sha256 = string
  })
  default = {
    url    = "https://raw.githubusercontent.com/k3s-io/k3s/v1.36.4%2Bk3s1/install.sh"
    sha256 = "46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad"
  }
}

variable "api_host" {
  description = "An extra name or address for the Kubernetes API (a DNS name or virtual IP in front of the servers): it goes in the API's certificate and the kubeconfig. Defaults to the first server's address."
  type        = string
  default     = null
}

variable "flannel_backend" {
  description = "Pod networking between nodes: vxlan on a private network, wireguard-native to encrypt it when nodes reach each other over the internet."
  type        = string
  default     = "vxlan"
  validation {
    condition     = contains(["vxlan", "wireguard-native", "host-gw"], var.flannel_backend)
    error_message = "vxlan, wireguard-native or host-gw."
  }
}
