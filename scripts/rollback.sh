#!/usr/bin/env bash
# Roll an app back to the previous completed release. This is the same
# blue-green path used by CI when post-deploy smoke checks fail.
#
# Usage:
#   ./scripts/rollback.sh                 # previous release, fly.toml
#   ./scripts/rollback.sh <image-ref>     # explicit image
#   FLY_CONFIG=fly.node.toml ./scripts/rollback.sh
set -euo pipefail

FLY_CONFIG="${FLY_CONFIG:-fly.toml}"
APP="$(sed -n 's/^app = "\([^"]*\)"/\1/p' "$FLY_CONFIG" | head -1)"
FLY="fly"
command -v fly >/dev/null 2>&1 || FLY="flyctl"

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  IMAGE="$($FLY releases --image --json -a "$APP" \
    | jq -r '[.[] | select(.Status == "complete" and .ImageRef != "")][1].ImageRef // empty')"
fi

if [ -z "$IMAGE" ]; then
  echo "No previous completed release found for $APP." >&2
  exit 1
fi

echo "==> Rolling back $APP to $IMAGE (bluegreen)"
$FLY deploy --config "$FLY_CONFIG" --image "$IMAGE" --strategy bluegreen --yes
$FLY status --app "$APP"
