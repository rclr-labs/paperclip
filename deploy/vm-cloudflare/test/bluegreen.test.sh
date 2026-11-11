#!/usr/bin/env bash
# Integration test for bin/bluegreen.sh against a fake container runtime.
# Stubs `docker`, `curl` and `sleep` on PATH; the fake keeps container state
# in a temp dir and records a VIOLATION if two colours ever run with the
# scheduler on at the same time. No real containers, network or cloud.
# Assertions are eval-ed strings (single quotes on purpose); rc is read by them.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../bin/bluegreen.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fake="$work/fake"; bin="$work/bin"; mkdir -p "$fake" "$bin"
export FAKE_DIR="$fake" PAPERCLIP_STATE_DIR="$work/state" PATH="$bin:$PATH"
export PAPERCLIP_BOARD_TOKEN=test-token HEALTH_TIMEOUT=0 DRAIN_TIMEOUT=0

# ----------------------------------------------------------------- fakes
cat > "$bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$bin/docker" <<'EOF'
#!/usr/bin/env bash
# Fake docker: state in $FAKE_DIR/<container>.{running,env}
set -euo pipefail
d="$FAKE_DIR"; log() { echo "$*" >> "$d/events"; }
check_invariant() {
  local n=0 c
  for c in blue green; do
    if [ "$(cat "$d/paperclip-$c.running" 2>/dev/null)" = true ] \
       && grep -qx 'HEARTBEAT_SCHEDULER_ENABLED=true' "$d/paperclip-$c.env" 2>/dev/null; then n=$((n+1)); fi
  done
  [ $n -le 1 ] || { echo VIOLATION >> "$d/violations"; log "VIOLATION"; }
}
case "$1" in
  compose)
    shift; project=""; action=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -p) project="$2"; shift 2 ;;
        -f) shift 2 ;;
        up|stop|config) action="$1"; shift; break ;;
        *) shift ;;
      esac
    done
    color="${project#paperclip-}"
    case "$project:$action" in
      paperclip-edge:up) echo true > "$d/paperclip-router.running"; log "edge up" ;;
      *:up)
        echo true > "$d/paperclip-$color.running"
        printf 'HEARTBEAT_SCHEDULER_ENABLED=%s\nIMAGE=%s\n' "$PAPERCLIP_SCHEDULER_ENABLED" "$PAPERCLIP_IMAGE" > "$d/paperclip-$color.env"
        log "up $color sched=$PAPERCLIP_SCHEDULER_ENABLED image=$PAPERCLIP_IMAGE"
        check_invariant ;;
      *:stop)
        if [ "$(cat "$d/paperclip-$color.running" 2>/dev/null)" = true ]; then log "stop $color"; fi
        echo false > "$d/paperclip-$color.running" ;;
    esac ;;
  inspect)
    fmt="$3"; name="$4"
    [ -f "$d/$name.running" ] || exit 1
    case "$fmt" in
      *State.Running*) cat "$d/$name.running" ;;
      *Config.Env*) cat "$d/$name.env" ;;
    esac ;;
  exec)
    [ "${FAKE_ROUTER_FAIL:-0}" = 1 ] && [[ "$*" == *wget* ]] && exit 1
    [[ "$*" == *reload* ]] && log "router reload -> $(grep -o 'paperclip-[a-z]*' "$PAPERCLIP_STATE_DIR/router/upstream.caddy")"
    exit 0 ;;
  kill) echo false > "$d/$2.running"; log "kill $2" ;;
  network|volume) exit 0 ;;
esac
EOF

cat > "$bin/curl" <<'EOF'
#!/usr/bin/env bash
# Fake curl: /api/health and /api/instance/task-drain on 127.0.0.1:310{1,2}.
set -euo pipefail
d="$FAKE_DIR"; method=GET; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -H|-d|--max-time) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in *:3101/*) c=blue ;; *:3102/*) c=green ;; *) exit 0 ;; esac
[ "$(cat "$d/paperclip-$c.running" 2>/dev/null)" = true ] || exit 7
image="$(sed -n 's/^IMAGE=//p' "$d/paperclip-$c.env")"
sched="$(sed -n 's/^HEARTBEAT_SCHEDULER_ENABLED=//p' "$d/paperclip-$c.env")"
case "$url" in
  */api/health)
    [ "$image" = "${FAKE_UNHEALTHY_IMAGE:-}" ] && exit 22
    [ "$sched" = true ] && [ "$image" = "${FAKE_UNHEALTHY_ACTIVE_IMAGE:-}" ] && exit 22
    echo '{"status":"ok"}' ;;
  */api/instance/task-drain)
    echo "drain $method $c" >> "$d/events"
    if [ "$method" = GET ]; then
      if [ "${FAKE_NEVER_QUIESCENT:-0}" = 1 ]; then
        echo '{"draining":true,"activeRuns":2,"pendingWakes":0,"quiescent":false}'
      else
        echo '{"draining":true,"activeRuns":0,"pendingWakes":0,"quiescent":true}'
      fi
    else
      echo '{}'
    fi ;;
esac
EOF
chmod +x "$bin"/*

# ----------------------------------------------------------------- helpers
pass=0; failn=0
ok()   { pass=$((pass+1)); echo "  ok   $*"; }
nok()  { failn=$((failn+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else nok "$1"; echo "        events:"; sed 's/^/          /' "$fake/events" 2>/dev/null || true; fi; }
running() { [ "$(cat "$fake/paperclip-$1.running" 2>/dev/null)" = true ]; }
sched()   { grep -qx 'HEARTBEAT_SCHEDULER_ENABLED=true' "$fake/paperclip-$1.env"; }
img()     { sed -n 's/^IMAGE=//p' "$fake/paperclip-$1.env"; }
active()  { cat "$PAPERCLIP_STATE_DIR/active"; }
routed()  { grep -q "paperclip-$1:3100" "$PAPERCLIP_STATE_DIR/router/upstream.caddy"; }
run() { set +e; "$script" "$@" >"$work/out" 2>&1; rc=$?; set -e; }
reset_events() { : > "$fake/events"; }

# ----------------------------------------------------------------- cases
echo "init"
run init img1
expect "init exits 0" '[ $rc -eq 0 ]'
expect "blue active, scheduler on, img1" 'running blue && sched blue && [ "$(img blue)" = img1 ] && [ "$(active)" = blue ]'

echo "happy deploy"
reset_events
run deploy img2
expect "deploy exits 0" '[ $rc -eq 0 ]'
expect "green active on img2 with scheduler" '[ "$(active)" = green ] && running green && sched green && [ "$(img green)" = img2 ]'
expect "blue stopped" '! running blue'
expect "router -> green" 'routed green'
expect "order: passive up, drain, stop blue, scheduler up" \
  '[ "$(grep -nE "^(up green sched=false|drain POST blue|stop blue|up green sched=true)" "$fake/events" | cut -d: -f2- | tr "\n" "|")" = "up green sched=false image=img2|drain POST blue|stop blue|up green sched=true image=img2|" ]'

echo "passive colour unhealthy -> abort, active untouched"
reset_events
FAKE_UNHEALTHY_IMAGE=img3 run deploy img3
expect "exits non-zero" '[ $rc -ne 0 ]'
expect "green still active on img2" '[ "$(active)" = green ] && running green && sched green && [ "$(img green)" = img2 ]'
expect "blue stopped again" '! running blue'
expect "no drain issued" '! grep -q "drain POST" "$fake/events"'

echo "drain never quiescent -> undrain, active untouched"
reset_events
FAKE_NEVER_QUIESCENT=1 run deploy img4
expect "exits non-zero" '[ $rc -ne 0 ]'
expect "undrain issued on green" 'grep -q "drain DELETE green" "$fake/events"'
expect "green still active with scheduler" 'running green && sched green && [ "$(active)" = green ]'
expect "blue stopped" '! running blue'

echo "unhealthy after scheduler on -> stop new, restart old with previous image"
reset_events
FAKE_UNHEALTHY_ACTIVE_IMAGE=img5 run deploy img5
expect "exits non-zero" '[ $rc -ne 0 ]'
expect "green back on img2 with scheduler" 'running green && sched green && [ "$(img green)" = img2 ]'
expect "blue (img5) stopped" '! running blue'
expect "router -> green" 'routed green'
expect "blue stopped before green restarted" \
  '[ "$(grep -oE "^(stop blue|up green sched=true)" "$fake/events" | tail -2 | tr "\n" "|")" = "stop blue|up green sched=true|" ]'

echo "route verification fails -> rollback"
reset_events
FAKE_ROUTER_FAIL=1 run deploy img6
expect "exits non-zero" '[ $rc -ne 0 ]'
expect "green back on img2" 'running green && sched green && [ "$(img green)" = img2 ] && ! running blue'

echo "rollback command"
run deploy img7
expect "deploy img7 ok (blue)" '[ $rc -eq 0 ] && [ "$(active)" = blue ] && [ "$(img blue)" = img7 ]'
run rollback
expect "rollback returns to img2 on green" '[ $rc -eq 0 ] && [ "$(active)" = green ] && [ "$(img green)" = img2 ] && ! running blue'

echo "missing board token refuses to deploy"
PAPERCLIP_BOARD_TOKEN="" run deploy img8
expect "exits non-zero, nothing started" '[ $rc -ne 0 ] && ! running blue && [ "$(img green)" = img2 ]'

echo "invariant"
expect "never two schedulers at once" '[ ! -s "$fake/violations" ]'

echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
