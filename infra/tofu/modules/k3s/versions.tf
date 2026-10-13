terraform {
  required_version = ">= 1.11.0"
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.4"
    }
  }
}
