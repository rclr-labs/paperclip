# Optional VM variant (var.platform == "vm"): one Compute Engine VM running
# deploy/vm-cloudflare (compose + cloudflared + blue/green script) against the
# same Cloud SQL + GCS. No public IP: ingress is the Cloudflare tunnel.

resource "google_compute_instance" "vm" {
  count        = local.gke ? 0 : 1
  name         = local.name
  machine_type = var.vm_machine_type
  zone         = "${var.region}-a"
  labels       = local.labels
  tags         = ["paperclip"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 30
    }
  }

  # PAPERCLIP_HOME. Survives VM replacement.
  attached_disk {
    source      = google_compute_disk.home[0].id
    device_name = "paperclip-home"
  }

  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
    # No access_config => no external IP. Egress via Cloud NAT.
  }

  service_account {
    email  = google_service_account.server.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot = true
  }

  metadata = {
    enable-oslogin = "TRUE"
    startup-script = templatefile("${path.module}/templates/vm-startup.sh.tftpl", {
      environment = var.environment
      project_id  = var.project_id
      secret_ids  = { for k, s in google_secret_manager_secret.env : k => s.secret_id }
      bucket      = google_storage_bucket.attachments.name
      public_url  = var.public_url
      image       = var.image.digest != "" ? "${var.image.repository}@${var.image.digest}" : "${var.image.repository}:${var.image.tag}"
    })
  }
}

resource "google_compute_disk" "home" {
  count  = local.gke ? 0 : 1
  name   = "${local.name}-home"
  type   = "pd-balanced"
  zone   = "${var.region}-a"
  size   = var.vm_disk_size_gb
  labels = local.labels
}

# Secret access for the VM comes from google_secret_manager_secret_iam_member.server
# (same service account).
