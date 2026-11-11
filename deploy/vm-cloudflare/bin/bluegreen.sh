#!/usr/bin/env bash
# bluegreen.sh — T2 active/passive cutover for one VM (compose or quadlet).
#
# Implements doc/plans/2026-11-11-distributed-deployment-architectures.md §2 T2:
#   1. start the idle colour PASSIVE (HEARTBEAT_SCHEDULER_ENABLED=false) on the
#      new image; health-check /api/health and smoke-test
#   2. drain the active colour (POST /api/instance/task-drain) until quiescent
#   3. stop the active colour
#   4. restart the new colour with the scheduler ON (the flag is read at boot)
#   5. route the router to the new colour and verify
#   rollback is automatic: before step 3 the old colour is simply undrained;
#   after step 3 the new colour is stopped completely BEFORE the old one is
#   started again with its previous image.
# Invariant: two colours never run with the scheduler on at the same time; a
# second scheduler would reap the first one's runs by PID.
#
# Usage:
#   bluegreen.sh init <image>     first boot: network, volume, edge, blue active
#   bluegreen.sh deploy <image>   cutover to <image> on the idle colour
#   bluegreen.sh rollback         cutover back to the previously active image
#   bluegreen.sh status
#
# Environment:
#   RUNTIME                compose (default) | quadlet (podman >= 5, systemd --user)
#   PAPERCLIP_BOARD_TOKEN  board API key of an instance admin, used for the task
#                          drain (`paperclipai token board create`). Required for
#                          deploy unless BLUEGREEN_SKIP_DRAIN=1.
#   BLUEGREEN_SKIP_DRAIN   1 = skip the drain; live runs are interrupted and
#                          recovered by the new colour's startup recovery.
#   HEALTH_TIMEOUT         seconds to wait for /api/health (default 600)
#   DRAIN_TIMEOUT          seconds to wait for quiescence (default 1800)
#   SMOKE_CMD              optional command run after the passive health check;
#                          BASE_URL points at the new colour. Non-zero = abort.
#   VERIFY_URL             optional public URL checked after routing, e.g.
#                          https://paperclip.example.com/api/health. With
#                          CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET the request
#                          carries a Cloudflare Access service token.
#   PAPERCLIP_STATE_DIR    default: deploy/vm-cloudflare/state
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_dir="$root/compose"
state_dir="${PAPERCLIP_STATE_DIR:-$root/state}"
runtime="${RUNTIME:-compose}"
health_timeout="${HEALTH_TIMEOUT:-600}"
drain_timeout="${DRAIN_TIMEOUT:-1800}"
network="${PAPERCLIP_NETWORK:-paperclip}"
home_volume="${PAPERCLIP_HOME_VOLUME:-paperclip-home}"
quadlet_dir="${QUADLET_DIR:-$HOME/.config/containers/systemd}"

case "$runtime" in
  compose) ctr=docker ;;
  quadlet) ctr=podman ;;
  *) echo "RUNTIME must be compose or quadlet" >&2; exit 64 ;;
esac

log()  { printf '%s bluegreen: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

port_of()  { case "$1" in blue) echo 3101 ;; green) echo 3102 ;; *) die "bad colour $1" ;; esac; }
other_of() { case "$1" in blue) echo green ;; green) echo blue ;; *) die "bad colour $1" ;; esac; }
base_url() { echo "http://127.0.0.1:$(port_of "$1")"; }

active_color() { cat "$state_dir/active" 2>/dev/null || echo ""; }
image_of()     { cat "$state_dir/$1.image" 2>/dev/null || echo ""; }

# ------------------------------------------------------------------ runtime
is_running() {
  [ "$("$ctr" inspect -f '{{.State.Running}}' "paperclip-$1" 2>/dev/null || echo false)" = "true" ]
}

scheduler_on() {
  is_running "$1" || return 1
  "$ctr" inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "paperclip-$1" \
    | grep -qx 'HEARTBEAT_SCHEDULER_ENABLED=true'
}

# start_color <colour> <image> <true|false>: (re)creates the container so the
# boot-time scheduler flag takes effect. Never a plain restart: that keeps the
# old environment.
start_color() {
  local color="$1" image="$2" sched="$3"
  if [ "$sched" = "true" ] && scheduler_on "$(other_of "$color")"; then
    die "refusing to start $color with the scheduler on while $(other_of "$color") has it on"
  fi
  log "starting $color image=$image scheduler=$sched"
  case "$runtime" in
    compose)
      PAPERCLIP_COLOR="$color" PAPERCLIP_HOST_PORT="$(port_of "$color")" \
      PAPERCLIP_IMAGE="$image" PAPERCLIP_SCHEDULER_ENABLED="$sched" \
        docker compose -p "paperclip-$color" -f "$compose_dir/server.compose.yml" \
        up -d --force-recreate --remove-orphans
      ;;
    quadlet)
      local dropin="$quadlet_dir/paperclip-$color.container.d"
      mkdir -p "$dropin"
      printf '[Container]\nImage=%s\nEnvironment=HEARTBEAT_SCHEDULER_ENABLED=%s\n' "$image" "$sched" \
        > "$dropin/50-bluegreen.conf.tmp"
      mv "$dropin/50-bluegreen.conf.tmp" "$dropin/50-bluegreen.conf"
      systemctl --user daemon-reload
      systemctl --user restart "paperclip-$color.service"
      ;;
  esac
  printf '%s\n' "$image" > "$state_dir/$color.image"
}

stop_color() {
  local color="$1"
  log "stopping $color"
  case "$runtime" in
    compose)
      PAPERCLIP_COLOR="$color" PAPERCLIP_HOST_PORT="$(port_of "$color")" \
      PAPERCLIP_IMAGE="$(image_of "$color")" \
        docker compose -p "paperclip-$color" -f "$compose_dir/server.compose.yml" stop -t 120 || true
      ;;
    quadlet)
      systemctl --user stop "paperclip-$color.service" || true
      # Units are WantedBy=default.target: a stopped colour comes back on the
      # next reboot, so it must come back PASSIVE.
      local dropin="$quadlet_dir/paperclip-$color.container.d/50-bluegreen.conf"
      if [ -f "$dropin" ]; then
        sed -i.bak 's/^Environment=HEARTBEAT_SCHEDULER_ENABLED=.*/Environment=HEARTBEAT_SCHEDULER_ENABLED=false/' "$dropin"
        rm -f "$dropin.bak"
        systemctl --user daemon-reload
      fi
      ;;
  esac
  # A stop that did not stop is a hard error: the next step may turn the
  # scheduler on elsewhere.
  if is_running "$color"; then
    log "$color still running after stop; killing"
    "$ctr" kill "paperclip-$color" >/dev/null 2>&1 || true
    sleep 2
    is_running "$color" && die "$color could not be stopped"
  fi
  return 0
}

wait_health() {
  local color="$1" deadline=$((SECONDS + health_timeout))
  log "waiting for $color /api/health (timeout ${health_timeout}s)"
  until curl -fsS --max-time 5 "$(base_url "$color")/api/health" >/dev/null 2>&1; do
    is_running "$color" || { log "$color exited during startup"; return 1; }
    [ $SECONDS -ge $deadline ] && { log "$color health timeout"; return 1; }
    sleep 5
  done
  log "$color healthy"
}

route_to() {
  local color="$1"
  mkdir -p "$state_dir/router"
  cat > "$state_dir/router/upstream.caddy.tmp" <<EOF
reverse_proxy paperclip-$color:3100 {
	# Stream live events / runner WebSockets without buffering.
	flush_interval -1
	health_uri /api/health
	health_interval 10s
}
EOF
  mv "$state_dir/router/upstream.caddy.tmp" "$state_dir/router/upstream.caddy"
  if is_running router; then
    "$ctr" exec paperclip-router caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  fi
  log "router -> $color"
}

verify_route() {
  local color="$1"
  # Through the router, i.e. the path cloudflared uses.
  "$ctr" exec paperclip-router wget -qO- --timeout=5 http://127.0.0.1:3100/api/health >/dev/null \
    || { log "router health check failed"; return 1; }
  if [ -n "${VERIFY_URL:-}" ]; then
    local args=(-fsS --max-time 10)
    if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
      args+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET:-}")
    fi
    curl "${args[@]}" "$VERIFY_URL" >/dev/null || { log "public verify failed: $VERIFY_URL"; return 1; }
  fi
  log "route to $color verified"
}

# ------------------------------------------------------------------- drain
api() {
  local method="$1" color="$2" path="$3"; shift 3
  curl -fsS --max-time 15 -X "$method" \
    -H "Authorization: Bearer ${PAPERCLIP_BOARD_TOKEN}" \
    -H "Content-Type: application/json" \
    "$(base_url "$color")$path" "$@"
}

drain_start() {
  local color="$1"
  [ "${BLUEGREEN_SKIP_DRAIN:-0}" = "1" ] && { log "drain skipped (BLUEGREEN_SKIP_DRAIN=1)"; return 0; }
  # TTL so a crashed script cannot leave the old colour draining forever
  # (server caps it at 24h).
  local ttl_ms=$(( (drain_timeout + 900) * 1000 ))
  log "draining $color (ttl ${ttl_ms}ms)"
  api POST "$color" /api/instance/task-drain -d "{\"ttlMs\":$ttl_ms}" >/dev/null
}

drain_wait() {
  local color="$1" deadline=$((SECONDS + drain_timeout)) status
  [ "${BLUEGREEN_SKIP_DRAIN:-0}" = "1" ] && return 0
  while :; do
    status="$(api GET "$color" /api/instance/task-drain)" || return 1
    if [ "$(jq -r '.quiescent' <<<"$status")" = "true" ]; then
      log "$color quiescent"
      return 0
    fi
    [ $SECONDS -ge $deadline ] && { log "drain timeout: $(jq -c '{activeRuns,pendingWakes}' <<<"$status")"; return 1; }
    log "$color draining: $(jq -c '{activeRuns,pendingWakes}' <<<"$status")"
    sleep 10
  done
}

drain_stop() {
  local color="$1"
  [ "${BLUEGREEN_SKIP_DRAIN:-0}" = "1" ] && return 0
  is_running "$color" || return 0
  log "undraining $color"
  api DELETE "$color" /api/instance/task-drain >/dev/null || log "WARN: could not undrain $color (TTL will expire it)"
}

# ----------------------------------------------------------------- rollback
# Failure before the active colour stopped: it never lost the scheduler.
rollback_before_stop() {
  local from="$1" to="$2"
  log "ROLLBACK (before stop): stopping $to, undraining $from"
  stop_color "$to"
  drain_stop "$from"
  log "rollback done: $from still active"
  exit 1
}

# Failure after the active colour stopped: stop the new colour COMPLETELY,
# then bring the old one back with its previous image and the scheduler on.
rollback_after_stop() {
  local from="$1" to="$2" prev_image="$3"
  log "ROLLBACK (after stop): stopping $to, restarting $from on $prev_image"
  stop_color "$to"
  start_color "$from" "$prev_image" true
  if wait_health "$from"; then
    route_to "$from"
    log "rollback done: $from active again"
    exit 1
  fi
  log "FATAL: rollback failed, $from is not healthy. No colour is serving; intervene manually."
  exit 2
}

# ----------------------------------------------------------------- commands
preflight() {
  command -v curl >/dev/null || die "curl required"
  command -v jq >/dev/null || die "jq required"
  mkdir -p "$state_dir/router"
  if scheduler_on blue && scheduler_on green; then
    # Should never happen; stop the colour the router is not pointing at.
    local keep; keep="$(active_color)"; [ -n "$keep" ] || keep=blue
    log "INVARIANT VIOLATION: both colours run the scheduler; stopping $(other_of "$keep")"
    stop_color "$(other_of "$keep")"
  fi
}

cmd_init() {
  local image="${1:?usage: init <image>}"
  preflight
  [ -z "$(active_color)" ] || die "already initialised (active=$(active_color)); use deploy"
  "$ctr" network inspect "$network" >/dev/null 2>&1 || "$ctr" network create "$network" >/dev/null
  "$ctr" volume inspect "$home_volume" >/dev/null 2>&1 || "$ctr" volume create "$home_volume" >/dev/null
  route_to blue
  if [ "$runtime" = compose ]; then
    docker compose -p paperclip-edge -f "$compose_dir/edge.compose.yml" up -d
  else
    systemctl --user daemon-reload
    systemctl --user start paperclip-router.service paperclip-cloudflared.service
  fi
  stop_color green
  start_color blue "$image" true
  wait_health blue || die "blue did not become healthy"
  printf 'blue\n' > "$state_dir/active"
  log "initialised: blue active on $image"
}

cmd_deploy() {
  local image="${1:?usage: deploy <image>}"
  preflight
  local from; from="$(active_color)"
  [ -n "$from" ] || die "not initialised; run init first"
  local to; to="$(other_of "$from")"
  local prev_image; prev_image="$(image_of "$from")"
  [ -n "$prev_image" ] || die "no recorded image for $from"
  if [ "${BLUEGREEN_SKIP_DRAIN:-0}" != "1" ] && [ -z "${PAPERCLIP_BOARD_TOKEN:-}" ]; then
    die "PAPERCLIP_BOARD_TOKEN is required to drain $from (or set BLUEGREEN_SKIP_DRAIN=1)"
  fi
  is_running "$from" || die "$from is recorded active but not running; fix that before deploying"

  log "deploy $image: $from -> $to"

  # 1. passive green
  stop_color "$to"
  start_color "$to" "$image" false || { stop_color "$to"; die "could not start passive $to; $from untouched"; }
  if ! wait_health "$to"; then stop_color "$to"; die "passive $to unhealthy; $from untouched"; fi
  if [ -n "${SMOKE_CMD:-}" ]; then
    if ! BASE_URL="$(base_url "$to")" bash -c "$SMOKE_CMD"; then
      stop_color "$to"; die "smoke test failed on passive $to; $from untouched"
    fi
  fi

  # 2. drain blue
  drain_start "$from" || rollback_before_stop "$from" "$to"
  drain_wait "$from"  || rollback_before_stop "$from" "$to"

  # 3. stop blue — from here there is no scheduler until step 4 finishes.
  stop_color "$from"

  # 4. green with scheduler on (recreate: the flag is read at boot)
  start_color "$to" "$image" true || rollback_after_stop "$from" "$to" "$prev_image"
  wait_health "$to"               || rollback_after_stop "$from" "$to" "$prev_image"

  # 5. route + verify
  route_to "$to"
  verify_route "$to" || rollback_after_stop "$from" "$to" "$prev_image"

  printf '%s\n' "$to" > "$state_dir/active"
  printf '%s\n' "$prev_image" > "$state_dir/previous.image"
  log "done: $to active on $image ($from stopped, kept for rollback)"
}

cmd_rollback() {
  local prev; prev="$(cat "$state_dir/previous.image" 2>/dev/null || true)"
  [ -n "$prev" ] || die "no previous image recorded"
  cmd_deploy "$prev"
}

cmd_status() {
  local c
  echo "active: $(active_color)"
  for c in blue green; do
    printf '%-6s running=%-5s scheduler=%-5s image=%s\n' "$c" \
      "$(is_running "$c" && echo yes || echo no)" \
      "$(scheduler_on "$c" && echo on || echo off)" \
      "$(image_of "$c")"
  done
}

case "${1:-}" in
  init)     shift; cmd_init "$@" ;;
  deploy)   shift; cmd_deploy "$@" ;;
  rollback) shift; cmd_rollback ;;
  status)   cmd_status ;;
  *) sed -n '2,40p' "$0"; exit 64 ;;
esac
