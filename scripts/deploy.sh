#!/usr/bin/env bash
# Multi-app deploy (readme §7): pushes the same image to every region in
# FLY_REGIONS; each machine joins the anycast IPv4 for that app automatically.
#
# Usage:
#   FLY_REGIONS="lhr fra iad sjc" ./scripts/deploy.sh
#   FLY_REGIONS="lhr" FLY_SCALE=2 ./scripts/deploy.sh   # 2 machines per region
#   FLY_CONFIG=fly.node.toml ./scripts/deploy.sh     # staging app config
set -euo pipefail

FLY_REGIONS="${FLY_REGIONS:-fra}"
FLY_SCALE="${FLY_SCALE:-1}"
FLY_CONFIG="${FLY_CONFIG:-fly.toml}"
# Blue-green keeps the current set serving while the new set boots and passes
# health checks. Override with FLY_STRATEGY=rolling for emergency/manual use.
FLY_STRATEGY="${FLY_STRATEGY:-bluegreen}"
APP="$(sed -n 's/^app = "\([^"]*\)"/\1/p' "$FLY_CONFIG" | head -1)"

# binary name: 'fly' locally, 'flyctl' (setup-flyctl action name) on CI
FLY="fly"
command -v fly >/dev/null 2>&1 || FLY="flyctl"

echo "==> Deploying $APP ($FLY_CONFIG) to [$FLY_REGIONS], $FLY_SCALE machine(s) per region, strategy=$FLY_STRATEGY"
$FLY deploy --config "$FLY_CONFIG" --strategy "$FLY_STRATEGY"

for region in $FLY_REGIONS; do
  # Route is per region; scale ensures N warm machines (min_machines_running=1 in fly.toml)
  $FLY scale count "$FLY_SCALE" --region "$region" --app "$APP" --yes
  echo "==> $region: $FLY_SCALE machine(s) live"
done

$FLY status --app "$APP"
echo "Done. Regions: $FLY_REGIONS, scale $FLY_SCALE each."
