# EKS: install the portable chart on an existing cluster (create the cluster
# with your standard module, e.g. terraform-aws-modules/eks). Reuses the same
# RDS + EFS + S3 + Secrets Manager as the ECS path.
#
# S3 access uses IRSA: annotate the chart's ServiceAccount with a role that
# trusts the cluster OIDC provider (eks_irsa_role_arn output of your cluster
# module) and attach aws_iam_role_policy.task's document to it.

variable "eks_irsa_role_arn" {
  type        = string
  default     = ""
  description = "IAM role for the paperclip ServiceAccount (IRSA). Needs the same permissions as the ECS task role."
}

resource "kubernetes_namespace_v1" "paperclip" {
  count = local.eks ? 1 : 0
  metadata {
    name = "paperclip"
  }
}

resource "kubernetes_secret_v1" "env" {
  count = local.eks ? 1 : 0
  metadata {
    name      = "paperclip-env"
    namespace = kubernetes_namespace_v1.paperclip[0].metadata[0].name
  }
  data = local.secret_values
}

locals {
  chart_dir   = "${path.module}/../../helm/paperclip"
  public_host = trimprefix(trimprefix(var.public_url, "https://"), "http://")
  # "repo[:tag][@digest]" -> chart image fields (repo may contain a registry port).
  image_no_digest = split("@", var.image)[0]
  image_digest    = length(split("@", var.image)) > 1 ? split("@", var.image)[1] : ""
  image_last      = element(split("/", local.image_no_digest), length(split("/", local.image_no_digest)) - 1)
  image_tag       = length(split(":", local.image_last)) > 1 ? split(":", local.image_last)[1] : "latest"
  image_repo      = length(split(":", local.image_last)) > 1 ? trimsuffix(local.image_no_digest, ":${local.image_tag}") : local.image_no_digest
}

resource "helm_release" "paperclip" {
  count     = local.eks ? 1 : 0
  name      = "paperclip"
  namespace = kubernetes_namespace_v1.paperclip[0].metadata[0].name
  chart     = local.chart_dir

  values = [
    file("${local.chart_dir}/values-${var.topology}.yaml"),
    file("${local.chart_dir}/values-${var.environment}.yaml"),
    yamlencode({
      image = {
        repository = local.image_repo
        tag        = local.image_tag
        digest     = local.image_digest
      }
      server = { publicUrl = var.public_url }
      secrets = {
        provider = var.secrets_provider
      }
      storage = {
        provider = "s3"
        s3       = { bucket = aws_s3_bucket.attachments.bucket, region = var.region }
      }
      runLogs = {
        s3 = { enabled = true, bucket = aws_s3_bucket.attachments.bucket, region = var.region, prefix = "run-logs" }
      }
      envSecret = { existingSecret = "paperclip-env" }
      serviceAccount = {
        annotations = var.eks_irsa_role_arn == "" ? {} : { "eks.amazonaws.com/role-arn" = var.eks_irsa_role_arn }
      }
      execution = {
        mode       = var.execution_mode
        kubernetes = { namespacePrefix = "paperclip-${var.environment}-" }
      }
      persistence = { storageClass = var.eks_storage_class }
      ingress = {
        enabled   = true
        className = "alb"
        annotations = {
          "alb.ingress.kubernetes.io/scheme"                   = "internet-facing"
          "alb.ingress.kubernetes.io/target-type"              = "ip"
          "alb.ingress.kubernetes.io/healthcheck-path"         = "/api/health"
          "alb.ingress.kubernetes.io/load-balancer-attributes" = "idle_timeout.timeout_seconds=3600"
        }
        hosts = [{ host = local.public_host, paths = [{ path = "/", pathType = "Prefix" }] }]
      }
    }),
  ]

  timeout    = 900
  wait       = true
  depends_on = [kubernetes_secret_v1.env]
}
