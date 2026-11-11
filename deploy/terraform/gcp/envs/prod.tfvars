project_id  = "my-paperclip-prod"
environment = "prod"
platform    = "gke"
topology    = "t1"
public_url  = "https://paperclip.example.com"

image = {
  repository = "ghcr.io/paperclipai/paperclip"
  digest     = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}

db_tier                = "db-custom-4-15360"
db_high_availability   = true
db_deletion_protection = true
gke_node_machine_type  = "e2-standard-8"
gke_node_count         = 3
persistence_size       = "200Gi"
