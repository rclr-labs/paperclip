# deploy/

Infrastructure as code for the topologies in
[`doc/plans/2026-11-11-distributed-deployment-architectures.md`](../doc/plans/2026-11-11-distributed-deployment-architectures.md).
There is one core per concern instead of four copies.

| Folder | What | Topologies |
|---|---|---|
| [`helm/paperclip/`](helm/paperclip/README.md) | Portable chart: GKE, EKS, generic Kubernetes | T1, T2 (two releases), T3 shape (gated) |
| [`terraform/gcp/`](terraform/gcp/README.md) | Cloud SQL + GCS + GKE (installs the chart) or one VM | T1, T2, T3 shape |
| [`terraform/aws/`](terraform/aws/README.md) | RDS + EFS + S3 + ALB + ECS Fargate blue/green, or the chart on EKS | T1, T2 |
| [`vm-cloudflare/`](vm-cloudflare/README.md) | compose or quadlet + cloudflared + Access + `bin/bluegreen.sh` | T1, T2 |

## Invariants these files enforce

- **One scheduler per database.** The chart uses `strategy: Recreate` and
  refuses `replicaCount > 1`. The AWS `colors` variable refuses two running
  colours with the scheduler on. `bluegreen.sh` never starts a colour with
  the scheduler on while the other one has it, and its test checks this
  after every fake container mutation. The reason: before §6 fencing ships,
  a second scheduler reaps the first one's runs by PID.
- **T3 is blocked.** `replicaCount > 1` needs `fencing.enabled=true`. That
  value is an operator assertion that the image ships §6 items 1–4. Until
  then, `values-t3.yaml` renders only the T3 shape at one replica: RWX
  volume, object storage, in-cluster execution.
- **Passive → active is a restart.** `HEARTBEAT_SCHEDULER_ENABLED` is read
  at boot, so every tool recreates the container to change it.
- **One database per environment.** The same image digest is promoted
  dev → staging → prod; only values/tfvars differ. Sandbox namespaces are
  per environment too: `paperclip-dev-`, `paperclip-stg-`, `paperclip-prd-`.

## Validate (offline)

```sh
deploy/scripts/validate.sh
```

This runs the following. None of it touches a cloud.

- `helm lint` + `helm template` for every topology × environment.
- Negative guard checks.
- `terraform init -backend=false && terraform validate`, `fmt -check`, and
  `terraform test` (mock providers, plan only) for every root.
- `docker compose config` for both colours and the edge.
- `bash -n` + shellcheck.
- The fake-runtime blue/green integration test.

**Never run `terraform apply` from CI.**

Not covered offline: the quadlet units have no validator outside a Linux
host with podman, and real cloud plans need credentials.
