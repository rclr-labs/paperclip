terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  backend "s3" {}
}

# CLOUDFLARE_API_TOKEN from the environment. Scopes: Account > Cloudflare
# Tunnel:Edit, Account > Access: Apps and Policies:Edit, Zone > DNS:Edit.
provider "cloudflare" {}
