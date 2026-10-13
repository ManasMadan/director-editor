# A k3s cluster on machines you already have: one server, several servers (embedded
# etcd, so any one can fail when there are three or more), and any number of agents.
#
# It installs over SSH with terraform_data and the built-in file and remote-exec
# provisioners rather than a provider: the community SSH providers are unmaintained,
# and this needs nothing but the machines' SSH. The same configuration is rendered as
# cloud-init user data (the cloud_init output) for machines created with it instead.
#
# OpenTofu generates the cluster's certificate authorities before the first server
# starts, and k3s uses CAs it finds on disk instead of making its own. That gives
# OpenTofu an admin credential without reading anything back from a server, and lets
# every joining node check it's talking to this cluster (the CA's hash is in the join
# token).
#
# What each node gets: /etc/rancher/k3s/config.yaml (k3s's flags), and a node password
# kept in state, so a replacement machine under the same name rejoins as that node.
# Traefik is off (the platform runs Envoy Gateway); ServiceLB stays, so LoadBalancer
# Services (the gateway's 80/443, the mail server's ports) listen on every node.

locals {
  servers = sort([for name, node in var.nodes : name if node.role == "server"])
  agents  = sort([for name, node in var.nodes : name if node.role == "agent"])
  first   = local.servers[0]
  ha      = length(local.servers) > 1

  api_host = coalesce(var.api_host, var.nodes[local.first].address)
  api_url  = "https://${local.api_host}:6443"
  join_url = "https://${coalesce(var.nodes[local.first].private_address, var.nodes[local.first].address)}:6443"
}

check "etcd_quorum" {
  assert {
    condition     = length(local.servers) != 2
    error_message = "Two servers tolerate no failure (etcd needs a majority): run one or three."
  }
}

# ------------------------------------------------------------------ credentials

resource "random_password" "token" {
  length  = 48
  special = false
}

# Agents join with their own token, which can't join a server (or read etcd).
resource "random_password" "agent_token" {
  length  = 48
  special = false
}

resource "random_password" "node" {
  for_each = var.nodes
  length   = 32
  special  = false
}

locals {
  # The files k3s looks for in server/tls before it generates its own.
  cas = toset(["server-ca", "client-ca", "request-header-ca", "etcd/peer-ca", "etcd/server-ca"])
}

resource "tls_private_key" "ca" {
  for_each    = local.cas
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_self_signed_cert" "ca" {
  for_each          = local.cas
  private_key_pem   = tls_private_key.ca[each.key].private_key_pem
  is_ca_certificate = true
  # Ten years, like the CAs k3s makes itself.
  validity_period_hours = 87600
  allowed_uses          = ["cert_signing", "crl_signing", "digital_signature", "key_encipherment"]
  subject {
    common_name = "k3s-${replace(each.key, "/", "-")}"
  }
}

# Signs service account tokens.
resource "tls_private_key" "service_account" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

# OpenTofu's own admin credential (and the kubeconfig output's). Renewed by any apply in
# its last 60 days.
resource "tls_private_key" "admin" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "admin" {
  private_key_pem = tls_private_key.admin.private_key_pem
  subject {
    common_name  = "tofu"
    organization = "system:masters"
  }
}

resource "tls_locally_signed_cert" "admin" {
  cert_request_pem      = tls_cert_request.admin.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca["client-ca"].private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca["client-ca"].cert_pem
  validity_period_hours = 8760
  early_renewal_hours   = 1440
  allowed_uses          = ["client_auth", "digital_signature", "key_encipherment"]
}

locals {
  # k3s's secure token format: joining nodes check the server's CA against the hash.
  ca_hash    = sha256(tls_self_signed_cert.ca["server-ca"].cert_pem)
  join_token = "K10${local.ca_hash}::server:${random_password.token.result}"
  node_token = "K10${local.ca_hash}::node:${random_password.agent_token.result}"
}

# ------------------------------------------------------------------ configuration

locals {
  # k3s's flags per node, as its config file.
  config = { for name, node in var.nodes : name => merge(
    {
      "node-name"  = name
      "node-ip"    = coalesce(node.private_address, node.address)
      "node-label" = [for key, value in node.labels : "${key}=${value}"]
      "node-taint" = node.taints
      token        = name == local.first ? random_password.token.result : node.role == "server" ? local.join_token : local.node_token
    },
    node.private_address != null ? { "node-external-ip" = node.address } : null,
    name != local.first ? { server = local.join_url } : null,
    node.role == "server" ? {
      "agent-token" = random_password.agent_token.result
      disable       = ["traefik"]
      # The API host and this server's public address, not the other servers': adding
      # a server changes nothing on the others.
      "tls-san"            = distinct([local.api_host, node.address])
      "flannel-backend"    = var.flannel_backend
      "secrets-encryption" = true
    } : null,
    # Embedded etcd once there's more than one server. Adding it to a running single
    # server converts its SQLite datastore to etcd on the restart.
    name == local.first && local.ha ? { "cluster-init" = true } : null,
  ) }

  # Only the first server gets the CAs; the others receive them when they join.
  tls_dir = "/var/lib/rancher/k3s/server/tls"
  ca_files = merge(
    { for ca in local.cas : "${local.tls_dir}/${ca}.crt" => tls_self_signed_cert.ca[ca].cert_pem },
    { for ca in local.cas : "${local.tls_dir}/${ca}.key" => tls_private_key.ca[ca].private_key_pem },
    { "${local.tls_dir}/service.key" = tls_private_key.service_account.private_key_pem },
  )

  # A shell script (run as root) that writes a node's files. The CAs are written only
  # once: a server that already has different ones stops here instead of being handed
  # a kubeconfig that won't work.
  files_script = { for name in keys(var.nodes) : name => join("\n", concat(
    [
      "set -eu",
      "umask 077",
      "put() { mkdir -p \"$(dirname \"$1\")\"; printf '%s' \"$2\" | base64 -d > \"$1\"; }",
      "put_once() { if [ -e \"$1\" ]; then printf '%s' \"$2\" | base64 -d | cmp -s - \"$1\" || { echo \"$1 isn't the CA OpenTofu generated for this cluster\" >&2; exit 1; }; else put \"$1\" \"$2\"; fi; }",
      "put /etc/rancher/k3s/config.yaml '${base64encode(yamlencode(local.config[name]))}'",
      "put /etc/rancher/node/password '${base64encode(random_password.node[name].result)}'",
    ],
    name != local.first ? [] : [for path in sort(keys(local.ca_files)) : "put_once ${path} '${base64encode(local.ca_files[path])}'"],
  )) }

  # Runs the files script at the given path, then the pinned k3s installer, which checks
  # the k3s binary against the release's checksums. Holds no secrets, so its output
  # shows in OpenTofu's.
  install_script = { for name, node in var.nodes : name => join("\n", [
    "set -eu",
    "files=\"$1\"",
    "trap 'rm -f \"$files\" /tmp/k3s-install.sh' EXIT",
    "if [ \"$(id -u)\" -eq 0 ]; then sudo=; else sudo=sudo; fi",
    "$sudo sh \"$files\"",
    "curl -sfL --retry 5 -o /tmp/k3s-install.sh '${var.installer.url}'",
    "echo '${var.installer.sha256}  /tmp/k3s-install.sh' | sha256sum -c -",
    "INSTALL_K3S_VERSION='${var.k3s_version}' INSTALL_K3S_EXEC='${node.role}' sh /tmp/k3s-install.sh",
  ]) }

  # What changes on a node reinstalls it (in place: k3s restarts, its pods keep running).
  triggers = { for name, node in var.nodes : name => {
    address = node.address
    files   = nonsensitive(sha256(local.files_script[name]))
    install = sha256(local.install_script[name])
  } }
}

# ------------------------------------------------------------------ install over SSH
#
# Three resources with the same body, for the order: the first server, then the other
# servers, then the agents (for upgrades too: agents never run ahead of the servers).
# The secrets go up as a file (removed by the install script) so the installer's output
# isn't hidden as sensitive.

resource "terraform_data" "first" {
  for_each         = var.install_over_ssh ? toset([local.first]) : toset([])
  triggers_replace = local.triggers[each.key]
  connection {
    type        = "ssh"
    host        = var.nodes[each.key].address
    user        = var.nodes[each.key].user
    private_key = var.ssh_private_key
    timeout     = "5m"
  }
  provisioner "file" {
    content     = local.files_script[each.key]
    destination = "/tmp/k3s-files.sh"
  }
  provisioner "remote-exec" {
    inline = ["sh -c '${replace(local.install_script[each.key], "'", "'\\''")}' install /tmp/k3s-files.sh"]
  }
  lifecycle {
    precondition {
      condition     = !terraform.applying || var.ssh_private_key != null
      error_message = "install_over_ssh needs ssh_private_key."
    }
  }
}

resource "terraform_data" "server" {
  for_each         = var.install_over_ssh ? toset(slice(local.servers, 1, length(local.servers))) : toset([])
  triggers_replace = local.triggers[each.key]
  connection {
    type        = "ssh"
    host        = var.nodes[each.key].address
    user        = var.nodes[each.key].user
    private_key = var.ssh_private_key
    timeout     = "5m"
  }
  provisioner "file" {
    content     = local.files_script[each.key]
    destination = "/tmp/k3s-files.sh"
  }
  provisioner "remote-exec" {
    inline = ["sh -c '${replace(local.install_script[each.key], "'", "'\\''")}' install /tmp/k3s-files.sh"]
  }
  depends_on = [terraform_data.first]
}

resource "terraform_data" "agent" {
  for_each         = var.install_over_ssh ? toset(local.agents) : toset([])
  triggers_replace = local.triggers[each.key]
  connection {
    type        = "ssh"
    host        = var.nodes[each.key].address
    user        = var.nodes[each.key].user
    private_key = var.ssh_private_key
    timeout     = "5m"
  }
  provisioner "file" {
    content     = local.files_script[each.key]
    destination = "/tmp/k3s-files.sh"
  }
  provisioner "remote-exec" {
    inline = ["sh -c '${replace(local.install_script[each.key], "'", "'\\''")}' install /tmp/k3s-files.sh"]
  }
  depends_on = [terraform_data.first, terraform_data.server]
}

# ------------------------------------------------------------------ cloud-init

locals {
  cloud_init = { for name in keys(var.nodes) : name => "#cloud-config\n${yamlencode({
    write_files = [{
      path        = "/run/k3s-files.sh"
      permissions = "0700"
      encoding    = "b64"
      content     = base64encode(local.files_script[name])
    }]
    runcmd = [["sh", "-c", local.install_script[name], "install", "/run/k3s-files.sh"]]
  })}" }
}
