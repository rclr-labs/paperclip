# Offline: mock providers, `plan` only. Proves the T2 guard rails in
# variables.tf without credentials or cloud resources.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "random" {}

variables {
  environment        = "dev"
  vpc_id             = "vpc-0"
  private_subnet_ids = ["subnet-a", "subnet-b"]
  public_subnet_ids  = ["subnet-c", "subnet-d"]
  public_url         = "http://paperclip.dev.example.com"
}

run "steady_state_blue_active" {
  command = plan
  assert {
    condition     = aws_ecs_service.server["blue"].desired_count == 1 && aws_ecs_service.server["green"].desired_count == 0
    error_message = "blue should run, green should be stopped"
  }
}

run "green_passive_alongside_blue" {
  command = plan
  variables {
    colors = {
      blue  = { desired_count = 1, scheduler_enabled = true }
      green = { desired_count = 1, scheduler_enabled = false }
    }
  }
}

run "refuses_two_schedulers" {
  command = plan
  variables {
    colors = {
      blue  = { desired_count = 1, scheduler_enabled = true }
      green = { desired_count = 1, scheduler_enabled = true }
    }
  }
  expect_failures = [var.colors]
}

run "refuses_replicas_before_fencing" {
  command = plan
  variables {
    colors = {
      blue = { desired_count = 2, scheduler_enabled = true }
    }
  }
  expect_failures = [var.colors]
}
