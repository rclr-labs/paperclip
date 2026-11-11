output "rds_endpoint" {
  value = aws_db_instance.this.address
}

output "efs_id" {
  value = aws_efs_file_system.home.id
}

output "bucket" {
  value = aws_s3_bucket.attachments.bucket
}

output "alb_dns_name" {
  value = local.ecs ? aws_lb.this[0].dns_name : null
}

output "ecs_services" {
  value = { for k, s in aws_ecs_service.server : k => s.name }
}

output "active_color" {
  value = local.ecs ? var.active_color : null
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}
