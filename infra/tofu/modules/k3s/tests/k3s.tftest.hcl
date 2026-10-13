# Against mocked random and tls providers, so every value is fixed and known at plan.
# The SSH runs are plans: provisioners only run on apply, and there's no machine to
# reach here. Cloud-init has no provisioners, so those runs apply.

mock_provider "random" {
  mock_resource "random_password" {
    defaults = { result = "secret" }
  }
}
mock_provider "tls" {
  # Not PEM on purpose: nothing here parses the key, and a PEM-shaped fake is what secret
  # scanners are built to find.
  mock_resource "tls_private_key" {
    defaults = { private_key_pem = "mock-private-key" }
  }
  mock_resource "tls_self_signed_cert" {
    defaults = { cert_pem = "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n" }
  }
  mock_resource "tls_locally_signed_cert" {
    defaults = { cert_pem = "-----BEGIN CERTIFICATE-----\nadmin\n-----END CERTIFICATE-----\n" }
  }
}

variables {
  name            = "boilerplate-staging"
  ssh_private_key = "-----BEGIN OPENSSH PRIVATE KEY-----"
  nodes = {
    server-1 = { address = "203.0.113.10", role = "server" }
  }
}

run "one_server" {
  command = plan
  assert {
    condition     = keys(terraform_data.first) == ["server-1"] && length(terraform_data.server) == 0 && length(terraform_data.agent) == 0
    error_message = "a single server is installed as the first one"
  }
  assert {
    condition     = !contains(keys(local.config["server-1"]), "cluster-init") && !contains(keys(local.config["server-1"]), "server")
    error_message = "a single server keeps SQLite and joins nothing"
  }
  assert {
    condition     = local.config["server-1"].disable == ["traefik"] && local.config["server-1"]["secrets-encryption"]
    error_message = "Traefik is off (Envoy Gateway replaces it), Secrets are encrypted at rest"
  }
  assert {
    condition     = local.config["server-1"].token == "secret" && local.config["server-1"]["agent-token"] == "secret"
    error_message = "the first server takes the plain tokens"
  }
  assert {
    condition     = local.config["server-1"]["node-ip"] == "203.0.113.10" && !contains(keys(local.config["server-1"]), "node-external-ip")
    error_message = "without a private network the public address is the node's"
  }
  assert {
    condition     = output.api_url == "https://203.0.113.10:6443"
    error_message = "the API is on the first server"
  }
  assert {
    condition     = yamldecode(output.kubeconfig).clusters[0].cluster.server == "https://203.0.113.10:6443" && yamldecode(output.kubeconfig).users[0].user["client-certificate-data"] == base64encode("-----BEGIN CERTIFICATE-----\nadmin\n-----END CERTIFICATE-----\n") && yamldecode(output.kubeconfig).users[0].user["client-key-data"] == base64encode("mock-private-key")
    error_message = "the kubeconfig carries OpenTofu's admin certificate"
  }
}

run "pins_and_verifies_the_installer" {
  command = plan
  assert {
    condition     = strcontains(local.install_script["server-1"], "curl -sfL --retry 5 -o /tmp/k3s-install.sh 'https://raw.githubusercontent.com/k3s-io/k3s/v1.36.4%2Bk3s1/install.sh'")
    error_message = "the installer comes from a pinned tag"
  }
  assert {
    condition     = strcontains(local.install_script["server-1"], "echo '46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad  /tmp/k3s-install.sh' | sha256sum -c -")
    error_message = "the installer is checked before it runs"
  }
  assert {
    condition     = strcontains(local.install_script["server-1"], "INSTALL_K3S_VERSION='v1.36.4+k3s1' INSTALL_K3S_EXEC='server' sh /tmp/k3s-install.sh")
    error_message = "the pinned k3s version, as a server"
  }
  assert {
    condition     = !strcontains(local.install_script["server-1"], "secret")
    error_message = "the install script holds no secrets, so its output isn't hidden"
  }
}

run "writes_the_cas_on_the_first_server_only_once" {
  command = plan
  variables {
    nodes = {
      server-1 = { address = "203.0.113.10", role = "server" }
      agent-1  = { address = "203.0.113.20", role = "agent" }
    }
  }
  assert {
    condition = alltrue([for file in ["server-ca.crt", "server-ca.key", "client-ca.crt", "client-ca.key", "request-header-ca.crt", "request-header-ca.key", "etcd/peer-ca.crt", "etcd/peer-ca.key", "etcd/server-ca.crt", "etcd/server-ca.key", "service.key"] :
    strcontains(local.files_script["server-1"], "put_once /var/lib/rancher/k3s/server/tls/${file} ")])
    error_message = "every CA k3s would otherwise generate"
  }
  assert {
    condition     = !strcontains(local.files_script["agent-1"], "/var/lib/rancher/k3s/server/tls")
    error_message = "the CAs stay on the first server"
  }
  assert {
    condition     = strcontains(local.files_script["agent-1"], "put /etc/rancher/node/password '${base64encode("secret")}'")
    error_message = "each node's password is kept, so a rebuilt machine rejoins under its name"
  }
  assert {
    condition     = strcontains(local.files_script["agent-1"], "put /etc/rancher/k3s/config.yaml '${base64encode(yamlencode(local.config["agent-1"]))}'")
    error_message = "the config file is the rendered flags"
  }
}

run "ha_servers_and_agents" {
  command = plan
  variables {
    nodes = {
      server-1 = { address = "203.0.113.10", private_address = "10.0.0.10", role = "server" }
      server-2 = { address = "203.0.113.11", private_address = "10.0.0.11", role = "server" }
      server-3 = { address = "203.0.113.12", private_address = "10.0.0.12", role = "server" }
      agent-1 = {
        address         = "203.0.113.20"
        private_address = "10.0.0.20"
        user            = "ubuntu"
        role            = "agent"
        labels          = { "boilerplate.dev/mail" = "true" }
        taints          = ["dedicated=mail:NoSchedule"]
      }
    }
  }
  assert {
    condition     = keys(terraform_data.first) == ["server-1"] && keys(terraform_data.server) == ["server-2", "server-3"] && keys(terraform_data.agent) == ["agent-1"]
    error_message = "the first server, then the others, then the agents"
  }
  assert {
    condition     = local.config["server-1"]["cluster-init"] && !contains(keys(local.config["server-2"]), "cluster-init")
    error_message = "the first server starts embedded etcd, the others join it"
  }
  assert {
    condition     = local.config["server-2"].server == "https://10.0.0.10:6443" && local.config["agent-1"].server == "https://10.0.0.10:6443"
    error_message = "nodes join over the private network"
  }
  assert {
    condition     = local.config["server-2"].token == "K10${sha256("-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n")}::server:secret"
    error_message = "servers join with the secure token, pinned to the cluster's CA"
  }
  assert {
    condition     = local.config["agent-1"].token == "K10${sha256("-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n")}::node:secret"
    error_message = "agents join with the agent token"
  }
  assert {
    condition     = !contains(keys(local.config["agent-1"]), "disable") && !contains(keys(local.config["agent-1"]), "agent-token")
    error_message = "server flags stay off agents"
  }
  assert {
    condition     = local.config["agent-1"]["node-ip"] == "10.0.0.20" && local.config["agent-1"]["node-external-ip"] == "203.0.113.20"
    error_message = "cluster traffic on the private address, the public one as external"
  }
  assert {
    condition     = tolist(local.config["agent-1"]["node-label"]) == tolist(["boilerplate.dev/mail=true"]) && local.config["agent-1"]["node-taint"] == tolist(["dedicated=mail:NoSchedule"])
    error_message = "labels and taints"
  }
  assert {
    condition     = strcontains(local.install_script["agent-1"], "INSTALL_K3S_EXEC='agent'")
    error_message = "agents install the agent"
  }
}

run "growing_to_three_servers_converts_the_first_to_etcd" {
  command = plan
  variables {
    nodes = {
      server-1 = { address = "203.0.113.10", role = "server" }
      server-2 = { address = "203.0.113.11", role = "server" }
      server-3 = { address = "203.0.113.12", role = "server" }
    }
  }
  assert {
    condition     = local.config["server-1"]["cluster-init"] && local.config["server-1"]["tls-san"] == tolist(["203.0.113.10"])
    error_message = "the first server gains cluster-init (k3s moves SQLite to etcd on restart), nothing else"
  }
}

run "api_host_in_front_of_the_servers" {
  command = plan
  variables {
    api_host = "k8s.example.com"
  }
  assert {
    condition     = output.api_url == "https://k8s.example.com:6443" && local.config["server-1"]["tls-san"] == tolist(["k8s.example.com", "203.0.113.10"])
    error_message = "the API host is in the certificate and the kubeconfig"
  }
}

run "renders_cloud_init_with_the_same_configuration" {
  command = apply
  variables {
    install_over_ssh = false
    ssh_private_key  = null
    nodes = {
      server-1 = { address = "203.0.113.10", role = "server" }
      agent-1  = { address = "203.0.113.20", role = "agent" }
    }
  }
  assert {
    condition     = length(terraform_data.first) == 0 && length(terraform_data.agent) == 0
    error_message = "nothing is installed over SSH"
  }
  assert {
    condition     = startswith(output.cloud_init["agent-1"], "#cloud-config\n")
    error_message = "cloud-init reads user data with this header"
  }
  assert {
    condition     = base64decode(yamldecode(output.cloud_init["server-1"]).write_files[0].content) == local.files_script["server-1"]
    error_message = "the same files as over SSH"
  }
  assert {
    condition     = yamldecode(output.cloud_init["agent-1"]).runcmd[0] == ["sh", "-c", local.install_script["agent-1"], "install", "/run/k3s-files.sh"]
    error_message = "the same installer as over SSH"
  }
  assert {
    condition     = yamldecode(output.cloud_init["server-1"]).write_files[0].path == "/run/k3s-files.sh" && yamldecode(output.cloud_init["server-1"]).write_files[0].permissions == "0700"
    error_message = "the secrets go to a root-only file on tmpfs"
  }
}

# Applied without SSH (the configuration is the same either way), so the next run can
# compare against this one's output.
run "adding_an_agent_leaves_the_server_alone" {
  command = apply
  variables {
    install_over_ssh = false
    nodes = {
      server-1 = { address = "203.0.113.10", role = "server" }
      agent-1  = { address = "203.0.113.20", role = "agent" }
      agent-2  = { address = "203.0.113.21", role = "agent" }
    }
    before = run.renders_cloud_init_with_the_same_configuration.cloud_init["server-1"]
  }
  assert {
    condition     = output.cloud_init["server-1"] == var.before
    error_message = "the server's files and installer are what they were before the agent"
  }
}

run "warns_about_two_servers" {
  command = plan
  variables {
    nodes = {
      server-1 = { address = "203.0.113.10", role = "server" }
      server-2 = { address = "203.0.113.11", role = "server" }
    }
  }
  expect_failures = [check.etcd_quorum]
}

run "needs_a_key_to_install_over_ssh" {
  command = apply
  variables {
    ssh_private_key = null
  }
  expect_failures = [terraform_data.first]
}

# Pull request plans run without the SSH key (infra.yml).
run "plans_without_the_ssh_key" {
  command = plan
  variables {
    ssh_private_key = null
  }
}

run "needs_a_server" {
  command = plan
  variables {
    nodes = { agent-1 = { address = "203.0.113.20", role = "agent" } }
  }
  expect_failures = [var.nodes]
}

run "rejects_unknown_roles" {
  command = plan
  variables {
    nodes = { server-1 = { address = "203.0.113.10", role = "master" } }
  }
  expect_failures = [var.nodes]
}

run "rejects_ipv6_and_hostnames" {
  command = plan
  variables {
    nodes = { server-1 = { address = "server-1.example.com", role = "server" } }
  }
  expect_failures = [var.nodes]
}

run "rejects_malformed_taints" {
  command = plan
  variables {
    nodes = { server-1 = { address = "203.0.113.10", role = "server", taints = ["dedicated=mail"] } }
  }
  expect_failures = [var.nodes]
}

run "rejects_versions_that_arent_k3s_releases" {
  command = plan
  variables {
    k3s_version = "1.36.4"
  }
  expect_failures = [var.k3s_version]
}
