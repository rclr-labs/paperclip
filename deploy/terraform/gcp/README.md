# Terraform: GCP

Cloud SQL (Postgres 17, private IP) + GCS + GKE, which installs
[`../../helm/paperclip`](../../helm/paperclip/README.md). There is an
optional single-VM variant.

```sh
terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=paperclip/prod"
terraform plan -var-file=envs/prod.tfvars
```

**Do not run `apply` from CI.**

| Resource | Notes |
|---|---|
| Cloud SQL | Private IP via service networking, `ENCRYPTED_ONLY`, PITR, regional HA in prod |
| GCS bucket | Attachments + run logs through the S3 interoperability endpoint (see below) |
| Service account + HMAC key | The server's S3 client uses the AWS default credential chain, so it gets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| Secret Manager | One secret per env key. `PAPERCLIP_SECRETS_PROVIDER=local_encrypted` with `PAPERCLIP_SECRETS_MASTER_KEY` stored here, because `gcp_secret_manager` is still a stub in the server |
| GKE (`platform=gke`) | Dataplane V2 (enforces the sandbox NetworkPolicies), Workload Identity, Filestore CSI for T3 (`standard-rwx`) |
| Helm release | `values-<topology>.yaml` + `values-<env>.yaml` + Terraform overrides (bucket, endpoint, hostname, sandbox prefix `paperclip-<env>-`) |
| VM (`platform=vm`) | Debian VM with no public IP and a separate PD for `PAPERCLIP_HOME`. The startup script writes `/etc/paperclip/{secrets,instance}.env` from Secret Manager. Then run [`../../vm-cloudflare`](../../vm-cloudflare/README.md) |

GCS bucket settings: endpoint `https://storage.googleapis.com`, region
`auto`, path-style addressing.

## Environments

`envs/dev.tfvars`, `envs/staging.tfvars` and `envs/prod.tfvars` use GKE.
`envs/vm-prod.tfvars.example` uses the VM variant. Use one project and one
state prefix per environment.

## Notes

- Install the `kubernetes-sigs/agent-sandbox` controller in the cluster
  before using `execution_mode=kubernetes` with the default `sandbox-cr`
  backend.
- The Kubernetes Secret `paperclip-env` is created from the same values that
  go to Secret Manager. Switch to External Secrets Operator
  (`externalSecret.enabled` in the chart) so the values stop living in state
  twice.
- T2 on GKE: follow the chart README; Terraform owns only the blue release.
- **GCE ingress + `private` exposure:** the server's private hostname guard
  answers 403 to any Host it does not know. Kubelet probes in the chart send
  `Host: localhost`, so they pass. GCLB health checks, however, send the
  backend IP as Host and cannot override it, so with the default `gce` class
  they fail on dev/staging (`deploymentExposure: private`).
  - Either use an in-cluster ingress controller (`ingress_class = "nginx"`),
    or run `public` exposure behind IAP.
  - Prod (`public`) is not affected.
  - The chart's `BackendConfig` (enabled for `gce`) raises the backend
    timeout to 3600s for WebSockets.
- GCS through the S3 SDK needs
  `AWS_REQUEST_CHECKSUM_CALCULATION` / `AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`,
  because the SDK sends flexible checksums by default since 3.729. Both
  the chart overrides and the VM `instance.env` set them.
- The VM variant gets a Cloud Router + NAT, since it has no external IP.
- `terraform test` runs `tests/platforms.tftest.hcl` with mock providers. It
  checks the GKE and VM variants, the T3 RWX class, and per-environment
  sandbox prefixes.
