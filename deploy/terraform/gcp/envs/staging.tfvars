project_id  = "my-paperclip-staging"
environment = "staging"
platform    = "gke"
topology    = "t1"
public_url  = "https://paperclip.staging.example.com"

# CI sets the digest verified here and promotes the same one to prod.
image = {
  repository = "ghcr.io/paperclipai/paperclip"
  digest     = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}

db_tier              = "db-custom-2-7680"
db_high_availability = false
gke_node_count       = 2
persistence_size     = "50Gi"
