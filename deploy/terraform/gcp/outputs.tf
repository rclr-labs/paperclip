output "cloud_sql_instance" {
  value = google_sql_database_instance.this.connection_name
}

output "cloud_sql_private_ip" {
  value = google_sql_database_instance.this.private_ip_address
}

output "bucket" {
  value = google_storage_bucket.attachments.name
}

output "server_service_account" {
  value = google_service_account.server.email
}

output "gke_cluster" {
  value = local.gke ? google_container_cluster.this[0].name : null
}

output "vm_name" {
  value = local.gke ? null : google_compute_instance.vm[0].name
}

output "secret_ids" {
  value = { for k, s in google_secret_manager_secret.env : k => s.secret_id }
}
