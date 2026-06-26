#!/usr/bin/env bash
# Patch an existing CloudFront distribution so /api/* forwards X-CSRF-Token to EB.
# Without this header, login POSTs return 403 even when the browser sends a valid token.
#
# Usage:
#   ./fix-cloudfront-csrf-header.sh
#   ./fix-cloudfront-csrf-header.sh <distribution-id>
#
# Requires: aws CLI, jq

set -euo pipefail

CSRF_HEADER='X-CSRF-Token'
APP_NAME="${APP_NAME:-anot-backend}"
EB_ENV="${EB_ENV:-anot-backend-prod}"
DIST_COMMENT="${APP_NAME}-${EB_ENV}"

log() { echo "[fix-cf-csrf] $*"; }

if ! command -v jq >/dev/null 2>&1; then
  echo 'jq is required (https://stedolan.github.io/jq/)' >&2
  exit 1
fi

DIST_ID="${1:-}"
if [ -z "$DIST_ID" ] || [ "$DIST_ID" = 'None' ]; then
  DIST_ID="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].Id | [0]" \
    --output text 2>/dev/null || echo None)"
fi

if [ -z "$DIST_ID" ] || [ "$DIST_ID" = 'None' ]; then
  log "No CloudFront distribution found (comment: $DIST_COMMENT)."
  log 'Pass the distribution ID as the first argument.'
  exit 1
fi

log "Distribution: $DIST_ID"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

aws cloudfront get-distribution-config --id "$DIST_ID" > "$TMP"
ETAG="$(jq -r '.ETag' "$TMP")"
CONFIG="$(jq '.DistributionConfig' "$TMP")"

UPDATED="$(echo "$CONFIG" | jq --arg h "$CSRF_HEADER" '
  .CacheBehaviors.Items |= map(
    if .PathPattern == "/api/*" then
      .ForwardedValues.Headers.Items |= (
        if index($h) then . else . + [$h] end
      )
      | .ForwardedValues.Headers.Quantity = (.ForwardedValues.Headers.Items | length)
    else .
    end
  )
')"

CURRENT_HEADERS="$(echo "$CONFIG" | jq -r '.CacheBehaviors.Items[] | select(.PathPattern=="/api/*") | .ForwardedValues.Headers.Items | join(", ")')"
NEW_HEADERS="$(echo "$UPDATED" | jq -r '.CacheBehaviors.Items[] | select(.PathPattern=="/api/*") | .ForwardedValues.Headers.Items | join(", ")')"

if [ "$CURRENT_HEADERS" = "$NEW_HEADERS" ]; then
  log "Already forwarding $CSRF_HEADER. Headers: $NEW_HEADERS"
  exit 0
fi

log "Updating /api/* forwarded headers:"
log "  before: $CURRENT_HEADERS"
log "  after:  $NEW_HEADERS"

echo "$UPDATED" > "${TMP}.config"
aws cloudfront update-distribution \
  --id "$DIST_ID" \
  --if-match "$ETAG" \
  --distribution-config "file://${TMP}.config" \
  >/dev/null

log 'CloudFront update submitted. Propagation takes ~5–15 minutes.'
log 'Then retry login — EB logs should show [CSRF-LOGIN] Has header: true'
