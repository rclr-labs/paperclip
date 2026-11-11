locals {
  name = "paperclip-${var.environment}"
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------- security groups
resource "aws_security_group" "server" {
  name        = "${local.name}-server"
  description = "Paperclip server tasks"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group_rule" "server_from_alb" {
  count                    = local.eks ? 0 : 1
  type                     = "ingress"
  security_group_id        = aws_security_group.server.id
  from_port                = 3100
  to_port                  = 3100
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb[0].id
}

resource "aws_security_group" "db" {
  name   = "${local.name}-db"
  vpc_id = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.server.id]
  }
}

resource "aws_security_group" "efs" {
  name   = "${local.name}-efs"
  vpc_id = var.vpc_id

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.server.id]
  }
}

# ---------------------------------------------------------------------- RDS
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_instance" "this" {
  identifier                   = local.name
  engine                       = "postgres"
  engine_version               = "17"
  instance_class               = var.db_instance_class
  allocated_storage            = var.db_allocated_storage
  max_allocated_storage        = var.db_allocated_storage * 4
  storage_type                 = "gp3"
  storage_encrypted            = true
  db_name                      = "paperclip"
  username                     = "paperclip"
  password                     = random_password.db.result
  db_subnet_group_name         = aws_db_subnet_group.this.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  multi_az                     = var.db_multi_az
  backup_retention_period      = var.environment == "prod" ? 14 : 3
  deletion_protection          = var.db_deletion_protection
  skip_final_snapshot          = var.environment == "dev"
  final_snapshot_identifier    = var.environment == "dev" ? null : "${local.name}-final"
  performance_insights_enabled = true
  auto_minor_version_upgrade   = true
}

# ---------------------------------------------------------------------- EFS
# PAPERCLIP_HOME, shared by the blue and green services (and by T3 replicas
# once fencing ships).
resource "aws_efs_file_system" "home" {
  creation_token   = "${local.name}-home"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }
}

resource "aws_efs_mount_target" "home" {
  for_each        = toset(var.private_subnet_ids)
  file_system_id  = aws_efs_file_system.home.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "home" {
  file_system_id = aws_efs_file_system.home.id
  posix_user {
    uid = 1000
    gid = 1000
  }
  root_directory {
    path = "/paperclip"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0750"
    }
  }
}

# ----------------------------------------------------------------------- S3
resource "aws_s3_bucket" "attachments" {
  bucket        = "${local.name}-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.environment == "dev"
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  versioning_configuration {
    status = var.environment == "prod" ? "Enabled" : "Suspended"
  }
}

# ------------------------------------------------------------- Secrets Manager
resource "random_password" "better_auth" {
  length  = 48
  special = false
}

resource "random_password" "tool_action_signing" {
  length  = 48
  special = false
}

resource "random_id" "master_key" {
  byte_length = 32
}

locals {
  database_url = "postgres://paperclip:${random_password.db.result}@${aws_db_instance.this.address}:5432/paperclip?sslmode=require"

  secret_values = merge({
    DATABASE_URL                         = local.database_url
    BETTER_AUTH_SECRET                   = random_password.better_auth.result
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = random_password.tool_action_signing.result
    # Only read when secrets_provider = local_encrypted; harmless otherwise.
    PAPERCLIP_SECRETS_MASTER_KEY = random_id.master_key.b64_std
  }, var.extra_secrets)

  secret_keys = nonsensitive(toset(keys(local.secret_values)))
}

resource "aws_secretsmanager_secret" "env" {
  for_each = local.secret_keys
  name     = "paperclip/${var.environment}/${lower(replace(each.value, "_", "-"))}"
}

resource "aws_secretsmanager_secret_version" "env" {
  for_each      = local.secret_keys
  secret_id     = aws_secretsmanager_secret.env[each.value].id
  secret_string = local.secret_values[each.value]
}
