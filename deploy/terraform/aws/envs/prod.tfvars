environment         = "prod"
region              = "us-east-1"
platform            = "ecs"
vpc_id              = "vpc-00000000000000000"
private_subnet_ids  = ["subnet-00000000000000001", "subnet-00000000000000002", "subnet-00000000000000005"]
public_subnet_ids   = ["subnet-00000000000000003", "subnet-00000000000000004", "subnet-00000000000000006"]
public_url          = "https://paperclip.example.com"
acm_certificate_arn = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"

image                  = "ghcr.io/paperclipai/paperclip@sha256:0000000000000000000000000000000000000000000000000000000000000000"
db_instance_class      = "db.r7g.large"
db_multi_az            = true
db_deletion_protection = true
task_cpu               = 4096
task_memory            = 8192

# Steady state: blue active. A cutover edits `colors` + `active_color` in
# steps (README "Blue/green on ECS"); the variable validation refuses two
# running colours with the scheduler on.
active_color = "blue"
colors = {
  blue  = { desired_count = 1, scheduler_enabled = true }
  green = { desired_count = 0, scheduler_enabled = false }
}
