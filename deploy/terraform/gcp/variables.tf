variable "project_id" {
  type        = string
  description = "GCP project that holds this environment."
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "environment" {
  type        = string
  description = "dev | staging | prod. One database per environment, never shared."
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "platform" {
  type        = string
  default     = "gke"
  description = "gke = GKE + Helm chart; vm = single Compute Engine VM running deploy/vm-cloudflare."
  validation {
    condition     = contains(["gke", "vm"], var.platform)
    error_message = "platform must be gke or vm."
  }
}

variable "topology" {
  type        = string
  default     = "t1"
  description = "t1 (RWO disk) or t3 (Filestore RWX; replicas stay at 1 until fencing ships)."
  validation {
    condition     = contains(["t1", "t3"], var.topology)
    error_message = "topology must be t1 or t3 (t2 is a deploy procedure on top of t1)."
  }
}

variable "network" {
  type        = string
  default     = "default"
  description = "VPC name. Cloud SQL gets a private IP on it via service networking."
}

variable "subnetwork" {
  type    = string
  default = "default"
}

variable "public_url" {
  type        = string
  description = "Board origin, e.g. https://paperclip.example.com"
}

variable "image" {
  type = object({
    repository = string
    tag        = optional(string, "")
    digest     = optional(string, "")
  })
  default = {
    repository = "ghcr.io/paperclipai/paperclip"
    tag        = "latest"
  }
  description = "Promote the same digest across environments."
}

variable "db_tier" {
  type    = string
  default = "db-custom-2-7680"
}

variable "db_high_availability" {
  type    = bool
  default = false
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "gke_node_machine_type" {
  type    = string
  default = "e2-standard-4"
}

variable "gke_node_count" {
  type    = number
  default = 2
}

variable "gke_release_channel" {
  type    = string
  default = "REGULAR"
}

variable "persistence_size" {
  type    = string
  default = "50Gi"
}

variable "execution_mode" {
  type        = string
  default     = "kubernetes"
  description = "\"kubernetes\" runs agents as sandbox pods in the same GKE cluster; \"\" leaves environments to the board (ssh / hosted sandboxes)."
}

variable "k8s_namespace_prefix" {
  type        = string
  default     = ""
  description = "Tenant namespace prefix. Defaults to paperclip-<env>- so environments never share sandbox namespaces."
}

variable "ingress_class" {
  type    = string
  default = "gce"
}

variable "extra_secret_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "Extra keys for the paperclip-env Secret (ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, ...)."
}

variable "vm_machine_type" {
  type    = string
  default = "e2-standard-4"
}

variable "vm_disk_size_gb" {
  type    = number
  default = 100
}

variable "labels" {
  type    = map(string)
  default = {}
}
