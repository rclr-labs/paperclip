environment        = "dev"
region             = "us-east-1"
platform           = "ecs"
vpc_id             = "vpc-00000000000000000"
private_subnet_ids = ["subnet-00000000000000001", "subnet-00000000000000002"]
public_subnet_ids  = ["subnet-00000000000000003", "subnet-00000000000000004"]
public_url         = "http://paperclip.dev.example.com"

image                  = "ghcr.io/paperclipai/paperclip:latest"
db_instance_class      = "db.t4g.small"
db_deletion_protection = false
task_cpu               = 1024
task_memory            = 2048
