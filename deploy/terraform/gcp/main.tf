locals {
  name   = "paperclip-${var.environment}"
  labels = merge({ app = "paperclip", environment = var.environment }, var.labels)
}

resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com",
    "container.googleapis.com",
    "sqladmin.googleapis.com",
    "servicenetworking.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "file.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

data "google_compute_network" "this" {
  name = var.network
}

# ---------------------------------------------------------------- Cloud SQL
resource "google_compute_global_address" "sql_private" {
  name          = "${local.name}-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = data.google_compute_network.this.id
}

resource "google_service_networking_connection" "sql" {
  network                 = data.google_compute_network.this.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_private.name]
  depends_on              = [google_project_service.apis]
}

resource "google_sql_database_instance" "this" {
  name                = local.name
  database_version    = "POSTGRES_17"
  region              = var.region
  deletion_protection = var.db_deletion_protection

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = var.db_high_availability ? "REGIONAL" : "ZONAL"
    user_labels       = local.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = data.google_compute_network.this.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_service_networking_connection.sql]
}

resource "google_sql_database" "paperclip" {
  name     = "paperclip"
  instance = google_sql_database_instance.this.name
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "paperclip" {
  name     = "paperclip"
  instance = google_sql_database_instance.this.name
  password = random_password.db.result
}

# ------------------------------------------------------------- object storage
# Attachments + run logs through the GCS S3 interoperability endpoint.
resource "google_storage_bucket" "attachments" {
  name                        = "${var.project_id}-${local.name}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.environment == "dev"
  labels                      = local.labels

  versioning {
    enabled = var.environment == "prod"
  }
}

resource "google_service_account" "server" {
  account_id   = "${local.name}-srv"
  display_name = "Paperclip server (${var.environment})"
}

resource "google_storage_bucket_iam_member" "server_objects" {
  bucket = google_storage_bucket.attachments.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.server.email}"
}

# The server's S3 client uses the AWS default credential chain, so GCS is
# reached with HMAC keys exported as AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
resource "google_storage_hmac_key" "server" {
  service_account_email = google_service_account.server.email
}

# ------------------------------------------------------------------- secrets
# gcp_secret_manager is a stub in the server today, so the instance runs
# local_encrypted and the master key lives in Secret Manager (§4 matrix).
resource "random_id" "master_key" {
  byte_length = 32
}

resource "random_password" "better_auth" {
  length  = 48
  special = false
}

resource "random_password" "tool_action_signing" {
  length  = 48
  special = false
}

locals {
  database_url = "postgres://${google_sql_user.paperclip.name}:${random_password.db.result}@${google_sql_database_instance.this.private_ip_address}:5432/${google_sql_database.paperclip.name}?sslmode=require"

  env_secret = merge({
    DATABASE_URL                         = local.database_url
    BETTER_AUTH_SECRET                   = random_password.better_auth.result
    PAPERCLIP_SECRETS_MASTER_KEY         = random_id.master_key.b64_std
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = random_password.tool_action_signing.result
    AWS_ACCESS_KEY_ID                    = google_storage_hmac_key.server.access_id
    AWS_SECRET_ACCESS_KEY                = google_storage_hmac_key.server.secret
  }, var.extra_secret_env)
}

resource "google_secret_manager_secret" "env" {
  for_each  = nonsensitive(toset(keys(local.env_secret)))
  secret_id = "${local.name}-${lower(replace(each.value, "_", "-"))}"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "env" {
  for_each    = google_secret_manager_secret.env
  secret      = each.value.id
  secret_data = local.env_secret[each.key]
}

resource "google_secret_manager_secret_iam_member" "server" {
  for_each  = google_secret_manager_secret.env
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.server.email}"
}
