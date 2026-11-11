# Terraform: AWS

RDS (Postgres 17) + EFS (`PAPERCLIP_HOME`) + S3 + Secrets Manager, with two
platforms:

- **`platform=ecs`** (default): ECS Fargate behind an ALB, evolved from
  [`docker/ecs-task-definition.json`](../../../docker/ecs-task-definition.json).
  It keeps the same container, env, `/api/health` check and EFS mount, now
  through an access point with IAM auth.
- **`platform=eks`**: installs [`../../helm/paperclip`](../../helm/paperclip/README.md)
  on an existing EKS cluster. Create the cluster with your standard module;
  S3 access goes through IRSA (`eks_irsa_role_arn`).

```sh
terraform init -backend-config="bucket=<state>" -backend-config="key=paperclip/prod.tfstate" -backend-config="region=us-east-1"
terraform plan -var-file=envs/prod.tfvars
```

**Do not run `apply` from CI.**

## Blue/green on ECS (T2)

Each colour is its own task definition + service + target group. The ALB
listener sends 100% to `active_color`. Inside a colour, the service uses
`minimum_healthy_percent=0` / `maximum_percent=100`, so ECS stops the old
task before starting the new one and never overlaps two schedulers.

A cutover is a sequence of `plan`/`apply` runs (prod example, blue → green):

| Step | `colors` / `active_color` | Check |
|---|---|---|
| 1. Green passive | `green = { desired_count = 1, scheduler_enabled = false, image = "<new>" }` | Green target group healthy, smoke test |
| 2. Drain blue | (API) `POST /api/instance/task-drain` with an instance-admin board key | `GET` until `quiescent: true` |
| 3. Stop blue | `blue.desired_count = 0` | Blue task stopped |
| 4. Green active | `green.scheduler_enabled = true` (new task def ⇒ restart) | Green healthy |
| 5. Route | `active_color = "green"` | `/api/health` through the ALB |
| Rollback after step 3 | `green.desired_count = 0`, then `blue.desired_count = 1`, `active_color = "blue"` | |

The variable validation refuses two cases:

- two running colours with `scheduler_enabled = true`
- any `desired_count > 1`, which stays blocked until §6 fencing ships

`tests/bluegreen.tftest.hcl` (mock providers) proves both refusals.

## Secrets

- `PAPERCLIP_SECRETS_PROVIDER=aws_secrets_manager` is implemented. Company
  secrets live under `paperclip/<env>/*`, and the task role is scoped to
  that prefix.
- Bootstrap secrets are injected through the ECS `secrets` field:
  `DATABASE_URL`, `BETTER_AUTH_SECRET`, `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`,
  `PAPERCLIP_SECRETS_MASTER_KEY`.
- Add provider keys with the sensitive `extra_secrets` map.

## Environments

`envs/dev.tfvars` (HTTP only, small), `envs/staging.tfvars`,
`envs/prod.tfvars` (Multi-AZ, steady state blue), and
`envs/eks-prod.tfvars.example`. Use one account/VPC and one state key per
environment.
