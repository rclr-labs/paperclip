# Helm chart: paperclip

Portable chart for GKE, EKS and generic Kubernetes. Compose values as
topology + environment:

```sh
helm upgrade --install paperclip deploy/helm/paperclip -n paperclip \
  -f deploy/helm/paperclip/values-t1.yaml \
  -f deploy/helm/paperclip/values-prod.yaml \
  --set image.digest=sha256:...
```

| File | Purpose |
|---|---|
| `values.yaml` | Defaults, documented inline |
| `values-t1.yaml` | Single server, S3/GCS, RWO volume, in-cluster sandbox execution |
| `values-t2-green.yaml` | Passive green release of a blue/green pair |
| `values-t3.yaml` | Renders the T3 shape (RWX, object storage) at one replica. `replicaCount > 1` fails until fencing ships |
| `values-dev/staging/prod.yaml` | Hostnames, buckets, sizes and sandbox namespace prefix per environment |

## What it renders

- **Deployment** with `strategy: Recreate`.
  - It never uses a rolling update, because that would run two schedulers
    at once and multi-attach the RWO volume.
  - It runs as non-root, UID 1000 with `fsGroup`; the entrypoint skips its
    UID remap.
  - `/api/health` serves as the startup, liveness and readiness probe.
  - Grace period is 90s.
- **ConfigMap** with every non-secret variable:
  - `PAPERCLIP_STORAGE_*`, `RUN_LOG_S3_*`, `PAPERCLIP_EXECUTION_MODE`,
    `PAPERCLIP_K8S_*`
  - `HEARTBEAT_SCHEDULER_ENABLED`, `PAPERCLIP_MIGRATION_AUTO_APPLY`
- **Env Secret**, from one of three sources:
  - `envSecret.existingSecret`, a Secret you manage
  - `envSecret.create` (dev only)
  - `externalSecret.enabled`, which renders an External Secrets Operator
    `ExternalSecret`
- **PVC** for `PAPERCLIP_HOME`, kept on uninstall. Set `existingClaim` to
  share one between blue and green.
- **Service**, plus an optional **Ingress**.
  - The Service selector can be overridden, which is how T2 flips colours.
- **ClusterRole + Binding**, only when `execution.mode=kubernetes`.
  - The rules are derived from the Kubernetes sandbox provider's client
    calls in `packages/plugins/sandbox-providers/kubernetes/src`. The
    provider's `manifests/operator-prerequisites.yaml` lists cluster
    prerequisites only and ships no RBAC.
  - It is cluster-scoped because tenant namespaces are created lazily.
  - The provider needs these cluster prerequisites:
    - Kubernetes 1.27+
    - the `kubernetes-sigs/agent-sandbox` controller, for the default
      `sandbox-cr` backend
    - optionally, Cilium (`rbac.cilium=true`) and a kata `runtimeClass`

## Guards (`helm template` fails)

- `replicaCount > 1` while `fencing.enabled=false`.
- `replicaCount > 1`, or `topology=t3`, without a `ReadWriteMany` volume.
- `topology=t2` without `persistence.existingClaim`: green must share
  blue's `PAPERCLIP_HOME`.
- `storage.provider=s3` without a bucket.
- Conflicting secret sources.

## T2 blue/green on Kubernetes

1. Blue is the normal release (`values-prod.yaml` pins the stable Service
   to `paperclip.dev/color: blue`).
2. Install green, passive, on blue's claim:

   ```sh
   helm upgrade --install paperclip-green deploy/helm/paperclip \
     -f values-t1.yaml -f values-prod.yaml -f values-t2-green.yaml \
     --set persistence.existingClaim=paperclip-home --set image.digest=<new>
   ```

   Wait for `/api/health` and smoke-test through `kubectl port-forward`.
3. Drain blue:
   - `POST /api/instance/task-drain`, using an instance-admin board API key
     (`paperclipai token board create`).
   - Poll `GET /api/instance/task-drain` until `quiescent` is true.
4. Stop blue: `kubectl scale deploy/paperclip --replicas=0`.
5. Promote green: `helm upgrade paperclip-green ... --set scheduler.enabled=true`.
   The Recreate strategy restarts the pod.
6. Route: `helm upgrade paperclip ... --set service.selectorOverride.paperclip\.dev/color=green`.
7. To roll back, scale green to 0 first, then scale blue back to 1.

An RWO PVC attaches to one node only. `values-t2-green.yaml` therefore pins
green next to blue with `podAffinity`. Use an RWX class (Filestore / EFS) to
drop that constraint.
