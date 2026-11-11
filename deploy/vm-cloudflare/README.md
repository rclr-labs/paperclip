# VM + Cloudflare (T1, T2)

One VM runs Paperclip with no inbound exposure:

```
Cloudflare Access ─▶ tunnel ─▶ cloudflared ─▶ paperclip-router (caddy) ─▶ paperclip-blue | paperclip-green
                                                                            │
                                     external Postgres + S3/GCS + shared PAPERCLIP_HOME volume
```

This setup extends `docker/docker-compose.yml` and `docker/quadlet/` with:

- an external database (Cloud SQL, RDS, or any Postgres 17)
- object storage
- a Cloudflare tunnel
- a stable router, so a cutover never edits the tunnel
- two colours sharing one `PAPERCLIP_HOME` volume

| Path | What |
|---|---|
| `compose/server.compose.yml` | One colour (`PAPERCLIP_COLOR=blue\|green`), loopback port 3101/3102, **scheduler off by default** |
| `compose/edge.compose.yml` | Router + cloudflared (remotely managed tunnel) + optional `localdb` profile |
| `compose/router/Caddyfile` | Imports `state/router/upstream.caddy`, which `bluegreen.sh` writes |
| `quadlet/` | The same layout as rootless podman units (podman ≥ 5) |
| `cloudflare/` | Terraform: tunnel, ingress (every hostname → router), DNS CNAMEs, Access apps |
| `bin/bluegreen.sh` | `init` / `deploy` / `rollback` / `status` |
| `test/bluegreen.test.sh` | Integration test against a fake runtime |

## Setup

1. Provision the tunnel and Access:
   `cd cloudflare && terraform plan -var-file=envs/prod.tfvars`. Outputs:
   - `tunnel_token` → `CLOUDFLARE_TUNNEL_TOKEN`
   - the deploy service token → `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`
2. Write the host's env files:
   - `/etc/paperclip/secrets.env` (0600): `DATABASE_URL`,
     `BETTER_AUTH_SECRET`, `PAPERCLIP_SECRETS_MASTER_KEY`, the S3 or GCS
     HMAC keys, and provider keys.
   - `/etc/paperclip/instance.env`: storage and run-log settings.
   - The GCP VM variant (`deploy/terraform/gcp`, `platform=vm`) writes both
     files from Secret Manager.
3. Copy `compose/.env.example` to `compose/.env` and set the image and
   hostnames.
4. Run `bin/bluegreen.sh init <image>`. This creates the network and volume,
   starts the edge, and starts blue active.

## Deploy (T2, §2)

```sh
export PAPERCLIP_BOARD_TOKEN=...   # instance-admin board API key: paperclipai token board create
export VERIFY_URL=https://paperclip.example.com/api/health CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=...
deploy/vm-cloudflare/bin/bluegreen.sh deploy ghcr.io/paperclipai/paperclip@sha256:...
```

`deploy` runs these steps:

1. Start the idle colour **passive** on the new image. Health-check it and
   run `SMOKE_CMD` if set.
2. Drain the active colour (`POST /api/instance/task-drain` with a TTL),
   then poll until `quiescent`.
3. Stop the active colour, with a 120s grace for adapter settlement.
4. Recreate the new colour with `HEARTBEAT_SCHEDULER_ENABLED=true`.
   The flag is read at boot, so this is never a plain restart.
5. Point the router at the new colour (`caddy reload`). Verify through the
   router, then through `VERIFY_URL`.

Rollback is automatic:

- **Failure in step 1 or 2:** the new colour is stopped and the old one is
  undrained. The old colour never lost its scheduler.
- **Failure in step 4 or 5:** the new colour is stopped **completely**
  before the old one is recreated with its previous image and the scheduler
  on. The router then moves back.

`bluegreen.sh rollback` redeploys the previously active image through the
same safe flow.

Never two schedulers:

- `start_color` refuses to turn the scheduler on while the other colour has
  it on.
- `preflight` stops the non-routed colour if it ever finds both on.
- Compose uses `restart: unless-stopped`, so a manually stopped colour stays
  stopped across reboots.
- Quadlet rewrites a stopped colour's drop-in to passive.

Migrations: the new image applies pending migrations at boot, while passive.
Keep migrations backward compatible with the previous image for the
blue/green window (§5).

## Cloudflare Access

- **Board hostname** is behind an Access allow policy (emails or domains),
  plus a `non_identity` service-token policy for deploy verification.
  Invite links fail at Access ("That account does not have access") for
  anyone outside the policy. Add the invitee to the policy before sending
  the invite.
- **Machine hostname** (`PAPERCLIP_API_URL`, `PAPERCLIP_RUNNER_PUBLIC_URL`,
  `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL`) carries callers that cannot do an
  interactive login: sandboxes, remote runners, webhook senders.
  - By default it is an Access **bypass**. Paperclip still authenticates
    every request (agent JWT or key, runner token, provider signatures).
  - Set `machine_allowed_cidrs` to restrict it to known egress ranges.
- The tunnel routes both hostnames to the router. DNS records are CNAMEs to
  `<tunnel-id>.cfargotunnel.com`; the VM has no public IP.

## Quadlet

1. Copy `quadlet/*` to `~/.config/containers/systemd/`.
2. Copy `compose/router/Caddyfile` to `~/.config/paperclip/Caddyfile`.
3. Put the env files in `~/.config/paperclip/{instance,secrets,cloudflared}.env`.
4. Run the script with `RUNTIME=quadlet PAPERCLIP_STATE_DIR=~/.local/state/paperclip bin/bluegreen.sh init <image>`.

Quadlet units are not validated offline. Check them on the host with
`/usr/libexec/podman/quadlet -dryrun -user`.
