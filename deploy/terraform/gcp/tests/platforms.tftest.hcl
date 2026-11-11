# Offline: mock providers, `plan` only. Both platform variants must plan and
# keep execution environments per server environment (§5).
mock_provider "google" {
  mock_data "google_compute_network" {
    defaults = { id = "projects/p/global/networks/default" }
  }
}
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "random" {}

variables {
  project_id  = "p"
  environment = "staging"
  public_url  = "https://paperclip.staging.example.com"
}

run "gke_t1" {
  command = plan
  assert {
    condition     = length(google_container_cluster.this) == 1 && length(google_compute_instance.vm) == 0
    error_message = "gke platform should create the cluster only"
  }
  assert {
    condition     = local.k8s_prefix == "paperclip-staging-"
    error_message = "sandbox namespaces must be per environment"
  }
}

run "gke_t3_uses_rwx_class" {
  command = plan
  variables {
    topology = "t3"
  }
  assert {
    condition     = local.chart_overrides.persistence.storageClass == "standard-rwx"
    error_message = "t3 needs Filestore RWX"
  }
}

run "vm_variant" {
  command = plan
  variables {
    platform = "vm"
  }
  assert {
    condition     = length(google_container_cluster.this) == 0 && length(google_compute_instance.vm) == 1
    error_message = "vm platform should create the VM only"
  }
}
