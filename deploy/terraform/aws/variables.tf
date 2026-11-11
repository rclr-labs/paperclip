variable "region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "platform" {
  type        = string
  default     = "ecs"
  description = "ecs = Fargate services behind an ALB; eks = install the Helm chart on an existing EKS cluster."
  validation {
    condition     = contains(["ecs", "eks"], var.platform)
    error_message = "platform must be ecs or eks."
  }
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Subnets for RDS, EFS mount targets and ECS tasks (need NAT egress for agent providers)."
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "Subnets for the ALB (ecs platform)."
  default     = []
}

variable "public_url" {
  type = string
}

variable "acm_certificate_arn" {
  type        = string
  default     = ""
  description = "ACM certificate for the ALB HTTPS listener. Empty = HTTP only (dev)."
}

variable "alb_ingress_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

variable "image" {
  type        = string
  description = "Default image (repository:tag or repository@digest). Promote the same digest across environments."
  default     = "ghcr.io/paperclipai/paperclip:latest"
}

# ---------------------------------------------------------------- blue/green
# T2 on ECS: two services (blue, green) share RDS + EFS, the ALB listener
# weights pick one. Cutover is a sequence of applies, see README:
#   green: desired_count=1, scheduler_enabled=false      (passive smoke test)
#   blue:  desired_count=0                                (after task drain)
#   green: scheduler_enabled=true                         (new task = restart)
#   active_color = "green"                                (route)
# The validation below refuses two colours with the scheduler on.
variable "colors" {
  type = map(object({
    image             = optional(string, "")
    desired_count     = number
    scheduler_enabled = bool
  }))
  default = {
    blue  = { desired_count = 1, scheduler_enabled = true }
    green = { desired_count = 0, scheduler_enabled = false }
  }
  validation {
    condition     = length([for c in values(var.colors) : c if c.scheduler_enabled && c.desired_count > 0]) <= 1
    error_message = "At most one running colour may have scheduler_enabled=true (doc/plans/2026-11-11-distributed-deployment-architectures.md §2 T2)."
  }
  validation {
    condition     = alltrue([for c in values(var.colors) : c.desired_count <= 1])
    error_message = "desired_count > 1 is blocked until multi-process fencing ships (§6)."
  }
  validation {
    condition     = alltrue([for k in keys(var.colors) : contains(["blue", "green"], k)])
    error_message = "colors keys must be blue and/or green."
  }
}

variable "active_color" {
  type    = string
  default = "blue"
  validation {
    condition     = contains(["blue", "green"], var.active_color)
    error_message = "active_color must be blue or green."
  }
}

variable "task_cpu" {
  type    = number
  default = 2048
}

variable "task_memory" {
  type    = number
  default = 4096
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "secrets_provider" {
  type        = string
  default     = "aws_secrets_manager"
  description = "aws_secrets_manager (implemented) or local_encrypted."
}

variable "extra_secrets" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "Extra env secrets (ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, ...). Stored in Secrets Manager."
}

# ------------------------------------------------------------------- eks only
variable "eks_cluster_name" {
  type    = string
  default = ""
}

variable "eks_storage_class" {
  type        = string
  default     = "gp3"
  description = "gp3 (EBS, RWO) for t1; an EFS CSI class for t3."
}

variable "topology" {
  type    = string
  default = "t1"
  validation {
    condition     = contains(["t1", "t3"], var.topology)
    error_message = "topology must be t1 or t3."
  }
}

variable "execution_mode" {
  type    = string
  default = "kubernetes"
}

variable "tags" {
  type    = map(string)
  default = {}
}
