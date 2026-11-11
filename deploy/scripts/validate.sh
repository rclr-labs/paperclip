#!/usr/bin/env bash
# Offline validation for deploy/: helm lint + template per values combination,
# negative guard checks, terraform validate (no backend, no apply), docker
# compose config, shell syntax. Creates no cloud resource.
# ok() never fails, so `A && ok || bad` is a safe if/else here.
# shellcheck disable=SC2015
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart="$here/helm/paperclip"
fail=0
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }

echo "== helm"
helm lint "$chart" >/dev/null && ok "lint (defaults)" || bad "lint (defaults)"
combos=(
  "values-t1.yaml values-dev.yaml"
  "values-t1.yaml values-staging.yaml"
  "values-t1.yaml values-prod.yaml"
  "values-t1.yaml values-prod.yaml values-t2-green.yaml|--set persistence.existingClaim=paperclip-home"
  "values-t3.yaml values-dev.yaml"
  "values-t3.yaml values-staging.yaml"
  "values-t3.yaml values-prod.yaml"
)
for combo in "${combos[@]}"; do
  files="${combo%%|*}"; extra=""; [[ "$combo" == *"|"* ]] && extra="${combo#*|}"
  args=(); for f in $files; do args+=(-f "$chart/$f"); done
  # shellcheck disable=SC2086
  if helm lint "$chart" "${args[@]}" $extra >/dev/null 2>&1 \
     && helm template t "$chart" "${args[@]}" $extra >/dev/null 2>&1; then
    ok "lint+template $files $extra"
  else
    bad "lint+template $files $extra"
    # shellcheck disable=SC2086
    helm template t "$chart" "${args[@]}" $extra 2>&1 | tail -3
  fi
done

echo "== helm guards (must refuse)"
must_fail() {
  local label="$1"; shift
  if helm template t "$chart" "$@" >/dev/null 2>&1; then bad "$label rendered"; else ok "$label refused"; fi
}
must_fail "t3 replicaCount=2 without fencing" -f "$chart/values-t3.yaml" --set replicaCount=2
must_fail "t1 replicaCount=2"                 -f "$chart/values-t1.yaml" --set replicaCount=2
must_fail "replicas>1 on RWO even with fencing" -f "$chart/values-t1.yaml" --set replicaCount=2 --set fencing.enabled=true
must_fail "t3 on RWO"                         -f "$chart/values-t3.yaml" --set persistence.accessMode=ReadWriteOnce
must_fail "s3 without bucket"                 --set storage.provider=s3
must_fail "t2 green without shared claim"     -f "$chart/values-t1.yaml" -f "$chart/values-t2-green.yaml"
if helm template t "$chart" -f "$chart/values-t3.yaml" --set replicaCount=3 --set fencing.enabled=true >/dev/null 2>&1; then
  ok "t3 replicaCount=3 renders once fencing.enabled=true (post-§6 path)"
else
  bad "t3 with fencing.enabled=true should render"
fi

echo "== terraform"
for root in "$here"/terraform/gcp "$here"/terraform/aws "$here"/vm-cloudflare/cloudflare; do
  if (cd "$root" && terraform init -backend=false -input=false >/dev/null && terraform validate -no-color >/dev/null); then
    ok "validate ${root#"$here"/}"
  else
    bad "validate ${root#"$here"/}"; (cd "$root" && terraform validate -no-color | tail -20)
  fi
  (cd "$root" && terraform fmt -check -recursive >/dev/null) && ok "fmt ${root#"$here"/}" || bad "fmt ${root#"$here"/}"
  # Mock providers + plan only: no credentials, no cloud resources.
  [ -d "$root/tests" ] || continue
  if (cd "$root" && terraform test -no-color >/dev/null); then
    ok "test ${root#"$here"/}"
  else
    bad "test ${root#"$here"/}"; (cd "$root" && terraform test -no-color | tail -20)
  fi
done

echo "== docker compose"
vm="$here/vm-cloudflare"
for color in blue green; do
  if PAPERCLIP_COLOR=$color docker compose --env-file "$vm/compose/.env.example" -f "$vm/compose/server.compose.yml" -p "paperclip-$color" config -q; then
    ok "compose config server ($color)"
  else
    bad "compose config server ($color)"
  fi
done
if docker compose --env-file "$vm/compose/.env.example" -f "$vm/compose/edge.compose.yml" --profile localdb config -q; then
  ok "compose config (edge)"
else
  bad "compose config (edge)"
fi

echo "== blue/green script (fake runtime)"
bash "$here/vm-cloudflare/test/bluegreen.test.sh" >/dev/null && ok "bluegreen.test.sh" || { bad "bluegreen.test.sh"; bash "$here/vm-cloudflare/test/bluegreen.test.sh" | grep -A12 FAIL; }

echo "== shell"
for s in "$here"/vm-cloudflare/bin/*.sh "$here"/vm-cloudflare/test/*.sh "$here"/scripts/*.sh; do
  bash -n "$s" && ok "bash -n ${s#"$here"/}" || bad "bash -n ${s#"$here"/}"
  if command -v shellcheck >/dev/null; then
    shellcheck -x "$s" && ok "shellcheck ${s#"$here"/}" || bad "shellcheck ${s#"$here"/}"
  fi
done

exit $fail
