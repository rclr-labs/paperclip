terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    # helm >= 3 takes `kubernetes = { ... }` as an attribute, not a block.
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state per environment, e.g.:
  #   terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=paperclip/prod"
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_client_config" "current" {}

locals {
  gke = var.platform == "gke"
}

provider "kubernetes" {
  host                   = local.gke ? "https://${google_container_cluster.this[0].endpoint}" : null
  token                  = data.google_client_config.current.access_token
  cluster_ca_certificate = local.gke ? base64decode(google_container_cluster.this[0].master_auth[0].cluster_ca_certificate) : null
}

provider "helm" {
  kubernetes = {
    host                   = local.gke ? "https://${google_container_cluster.this[0].endpoint}" : null
    token                  = data.google_client_config.current.access_token
    cluster_ca_certificate = local.gke ? base64decode(google_container_cluster.this[0].master_auth[0].cluster_ca_certificate) : null
  }
}
