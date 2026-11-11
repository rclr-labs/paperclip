environment         = "staging"
region              = "us-east-1"
platform            = "ecs"
vpc_id              = "vpc-00000000000000000"
private_subnet_ids  = ["subnet-00000000000000001", "subnet-00000000000000002"]
public_subnet_ids   = ["subnet-00000000000000003", "subnet-00000000000000004"]
public_url          = "https://paperclip.staging.example.com"
acm_certificate_arn = "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"

# Same digest that will be promoted to prod.
image             = "ghcr.io/paperclipai/paperclip@sha256:0000000000000000000000000000000000000000000000000000000000000000"
db_instance_class = "db.t4g.medium"
