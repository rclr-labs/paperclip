# ECS Fargate, evolved from docker/ecs-task-definition.json: same container,
# env, health check and EFS mount, plus one service per colour (T2) behind a
# weighted ALB listener. Only when var.platform == "ecs".

locals {
  ecs    = !local.eks
  colors = local.ecs ? var.colors : {}

  base_environment = {
    NODE_ENV                              = "production"
    HOST                                  = "0.0.0.0"
    PORT                                  = "3100"
    SERVE_UI                              = "true"
    PAPERCLIP_HOME                        = "/paperclip"
    PAPERCLIP_INSTANCE_ID                 = "default"
    PAPERCLIP_CONFIG                      = "/paperclip/instances/default/config.json"
    PAPERCLIP_DEPLOYMENT_MODE             = "authenticated"
    PAPERCLIP_DEPLOYMENT_EXPOSURE         = "public"
    PAPERCLIP_PUBLIC_URL                  = var.public_url
    PAPERCLIP_MIGRATION_AUTO_APPLY        = "true"
    PAPERCLIP_SECRETS_PROVIDER            = var.secrets_provider
    PAPERCLIP_STORAGE_PROVIDER            = "s3"
    PAPERCLIP_STORAGE_S3_BUCKET           = aws_s3_bucket.attachments.bucket
    PAPERCLIP_STORAGE_S3_REGION           = var.region
    PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE = "false"
    RUN_LOG_S3_BUCKET                     = aws_s3_bucket.attachments.bucket
    RUN_LOG_S3_REGION                     = var.region
    RUN_LOG_S3_PREFIX                     = "run-logs"
  }
}

resource "aws_cloudwatch_log_group" "server" {
  count             = local.ecs ? 1 : 0
  name              = "/ecs/${local.name}"
  retention_in_days = var.environment == "prod" ? 90 : 14
}

resource "aws_ecs_cluster" "this" {
  count = local.ecs ? 1 : 0
  name  = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "server" {
  for_each                 = local.colors
  family                   = "${local.name}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "paperclip-server"
    image     = each.value.image != "" ? each.value.image : var.image
    essential = true
    # Matches docker/docker-compose.yml stop_grace_period (adapter settlement).
    stopTimeout  = 120
    portMappings = [{ containerPort = 3100, protocol = "tcp" }]
    environment = [for k, v in merge(local.base_environment, {
      # Read at boot only: flipping it is a new task definition => restart.
      HEARTBEAT_SCHEDULER_ENABLED = tostring(each.value.scheduler_enabled)
    }) : { name = k, value = v }]
    secrets = [for k in sort(tolist(local.secret_keys)) : {
      name      = k
      valueFrom = aws_secretsmanager_secret.env[k].arn
    }]
    mountPoints = [{ sourceVolume = "paperclip-data", containerPath = "/paperclip", readOnly = false }]
    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:3100/api/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 120
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.server[0].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])

  volume {
    name = "paperclip-data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.home.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.home.id
        iam             = "ENABLED"
      }
    }
  }
}

resource "aws_ecs_service" "server" {
  for_each        = local.colors
  name            = "${local.name}-${each.key}"
  cluster         = aws_ecs_cluster.this[0].id
  task_definition = aws_ecs_task_definition.server[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  # Stop the old task before starting the new one inside a colour: an ECS
  # rolling update would otherwise overlap two schedulers on one database.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 180

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.server.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.server[each.key].arn
    container_name   = "paperclip-server"
    container_port   = 3100
  }

  # With HTTPS the :80 listener only redirects; the target group is attached
  # through :443, which must exist before the service registers.
  depends_on = [aws_lb_listener.http, aws_lb_listener.https]
}

# ---------------------------------------------------------------------- ALB
resource "aws_security_group" "alb" {
  count  = local.ecs ? 1 : 0
  name   = "${local.name}-alb"
  vpc_id = var.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  count              = local.ecs ? 1 : 0
  name               = local.name
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb[0].id]
  # Live events and the runner use long-lived WebSockets.
  idle_timeout = 3600
}

resource "aws_lb_target_group" "server" {
  for_each    = local.colors
  name        = "${local.name}-${each.key}"
  port        = 3100
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  # Drain lets in-flight requests finish; agent runs are drained via the
  # task-drain API before a colour is scaled to zero (README).
  deregistration_delay = 60

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

locals {
  forward_weights = { for k, _ in local.colors : k => k == var.active_color ? 100 : 0 }
  https           = var.acm_certificate_arn != ""
}

resource "aws_lb_listener" "http" {
  count             = local.ecs ? 1 : 0
  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = local.https ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = local.https ? [] : [1]
    content {
      type = "forward"
      forward {
        dynamic "target_group" {
          for_each = local.forward_weights
          content {
            arn    = aws_lb_target_group.server[target_group.key].arn
            weight = target_group.value
          }
        }
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.ecs && local.https ? 1 : 0
  load_balancer_arn = aws_lb.this[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type = "forward"
    forward {
      dynamic "target_group" {
        for_each = local.forward_weights
        content {
          arn    = aws_lb_target_group.server[target_group.key].arn
          weight = target_group.value
        }
      }
    }
  }
}
