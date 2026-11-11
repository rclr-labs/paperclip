# GKE + Helm chart. Only when var.platform == "gke".

resource "google_container_cluster" "this" {
  count    = local.gke ? 1 : 0
  name     = local.name
  location = var.region

  network    = var.network
  subnetwork = var.subnetwork

  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = var.environment == "prod"

  release_channel {
    channel = var.gke_release_channel
  }

  # Dataplane V2 enforces the NetworkPolicy baseline the sandbox provider
  # writes into each tenant namespace.
  datapath_provider = "ADVANCED_DATAPATH"

  ip_allocation_policy {}

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  addons_config {
    # standard-rwx / premium-rwx storage classes for T3.
    gcp_filestore_csi_driver_config {
      enabled = true
    }
    gce_persistent_disk_csi_driver_config {
      enabled = true
    }
  }

  resource_labels = local.labels
  depends_on      = [google_project_service.apis]
}

resource "google_container_node_pool" "default" {
  count    = local.gke ? 1 : 0
  name     = "default"
  cluster  = google_container_cluster.this[0].id
  location = var.region

  node_count = var.gke_node_count

  node_config {
    machine_type = var.gke_node_machine_type
    disk_size_gb = 100
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    labels       = local.labels

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot = true
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

resource "kubernetes_namespace_v1" "paperclip" {
  count = local.gke ? 1 : 0
  metadata {
    name   = "paperclip"
    labels = local.labels
  }
  depends_on = [google_container_node_pool.default]
}

# Materialized from the same values that went to Secret Manager. Swap for an
# ExternalSecret (chart: externalSecret.enabled) once External Secrets
# Operator is installed, so values stop living in Terraform state twice.
resource "kubernetes_secret_v1" "env" {
  count = local.gke ? 1 : 0
  metadata {
    name      = "paperclip-env"
    namespace = kubernetes_namespace_v1.paperclip[0].metadata[0].name
  }
  data = local.env_secret
}

locals {
  chart_dir   = "${path.module}/../../helm/paperclip"
  k8s_prefix  = var.k8s_namespace_prefix != "" ? var.k8s_namespace_prefix : "paperclip-${var.environment}-"
  public_host = trimprefix(trimprefix(var.public_url, "https://"), "http://")

  chart_overrides = {
    image = var.image
    server = {
      publicUrl = var.public_url
      extraEnv = {
        # @aws-sdk/client-s3 >= 3.729 sends flexible checksums by default,
        # which the GCS S3 interoperability endpoint rejects.
        AWS_REQUEST_CHECKSUM_CALCULATION = "WHEN_REQUIRED"
        AWS_RESPONSE_CHECKSUM_VALIDATION = "WHEN_REQUIRED"
      }
    }
    gke = {
      backendConfig = { enabled = var.ingress_class == "gce" }
    }
    storage = {
      provider = "s3"
      s3 = {
        bucket         = google_storage_bucket.attachments.name
        region         = "auto"
        endpoint       = "https://storage.googleapis.com"
        forcePathStyle = true
      }
    }
    runLogs = {
      s3 = {
        enabled        = true
        bucket         = google_storage_bucket.attachments.name
        region         = "auto"
        endpoint       = "https://storage.googleapis.com"
        prefix         = "run-logs"
        forcePathStyle = true
      }
    }
    envSecret = {
      existingSecret = "paperclip-env"
    }
    execution = {
      mode = var.execution_mode
      kubernetes = {
        namespacePrefix = local.k8s_prefix
      }
    }
    persistence = {
      size         = var.persistence_size
      storageClass = var.topology == "t3" ? "standard-rwx" : "standard-rwo"
    }
    ingress = {
      enabled   = true
      className = var.ingress_class
      hosts     = [{ host = local.public_host, paths = [{ path = "/", pathType = "Prefix" }] }]
    }
  }
}

resource "helm_release" "paperclip" {
  count     = local.gke ? 1 : 0
  name      = "paperclip"
  namespace = kubernetes_namespace_v1.paperclip[0].metadata[0].name
  chart     = local.chart_dir

  values = [
    file("${local.chart_dir}/values-${var.topology}.yaml"),
    file("${local.chart_dir}/values-${var.environment}.yaml"),
    yamlencode(local.chart_overrides),
  ]

  # The chart's Recreate strategy + startup probe can take minutes on the
  # first boot (migrations, plugin install).
  timeout = 900
  wait    = true

  depends_on = [kubernetes_secret_v1.env]
}
