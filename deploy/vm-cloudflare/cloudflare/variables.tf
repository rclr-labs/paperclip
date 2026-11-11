variable "account_id" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "board_hostname" {
  type        = string
  description = "Human board, behind Cloudflare Access (e.g. paperclip.example.com)."
}

variable "machine_hostname" {
  type        = string
  description = "Machine traffic that cannot pass an Access login: agent callbacks (PAPERCLIP_API_URL), the runner WebSocket (/api/runner/v1/connect/*) and chat webhooks. Authenticated by Paperclip bearer tokens / provider signatures."
}

variable "allowed_emails" {
  type    = list(string)
  default = []
}

variable "allowed_email_domains" {
  type    = list(string)
  default = []
}

variable "machine_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = "Empty = bypass Access for the machine hostname (Paperclip auth only). Non-empty = only these egress ranges (sandbox provider / webhook senders) may reach it."
}

variable "router_service" {
  type    = string
  default = "http://paperclip-router:3100"
}

variable "session_duration" {
  type    = string
  default = "24h"
}
