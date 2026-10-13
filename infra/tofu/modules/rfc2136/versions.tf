terraform {
  required_version = ">= 1.11.0"
  required_providers {
    dns = {
      source  = "hashicorp/dns"
      version = "~> 3.4"
    }
  }
}
