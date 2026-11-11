project_id  = "my-paperclip-dev"
environment = "dev"
platform    = "gke"
topology    = "t1"
public_url  = "https://paperclip.dev.example.com"

db_tier                = "db-custom-1-3840"
db_high_availability   = false
db_deletion_protection = false
gke_node_count         = 1
persistence_size       = "20Gi"
