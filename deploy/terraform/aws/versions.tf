terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
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

  # terraform init -backend-config="bucket=<state>" -backend-config="key=paperclip/<env>.tfstate" -backend-config="region=<region>"
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = merge({ app = "paperclip", environment = var.environment }, var.tags)
  }
}

locals {
  eks = var.platform == "eks"
}

data "aws_eks_cluster" "this" {
  count = local.eks ? 1 : 0
  name  = var.eks_cluster_name
}

data "aws_eks_cluster_auth" "this" {
  count = local.eks ? 1 : 0
  name  = var.eks_cluster_name
}

provider "kubernetes" {
  host                   = local.eks ? data.aws_eks_cluster.this[0].endpoint : null
  cluster_ca_certificate = local.eks ? base64decode(data.aws_eks_cluster.this[0].certificate_authority[0].data) : null
  token                  = local.eks ? data.aws_eks_cluster_auth.this[0].token : null
}

provider "helm" {
  kubernetes = {
    host                   = local.eks ? data.aws_eks_cluster.this[0].endpoint : null
    cluster_ca_certificate = local.eks ? base64decode(data.aws_eks_cluster.this[0].certificate_authority[0].data) : null
    token                  = local.eks ? data.aws_eks_cluster_auth.this[0].token : null
  }
}
