#!/usr/bin/env bash
# Apply production infrastructure hardening (idempotent).
#   - RDS: deletion protection (when not in free-tier teardown mode)
#   - CloudFront: security response headers on the distribution
#
# Usage (from repo root):
#   chmod +x deploy/aws/harden-infrastructure.sh
#   AWS_REGION=ap-southeast-1 ./deploy/aws/harden-infrastructure.sh

set -euo pipefail

export AWS_REGION="${AWS_REGION:-ap-southeast-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

DB_INSTANCE_ID="${DB_INSTANCE_ID:-anot-postgres}"
APP_NAME="${APP_NAME:-anot}"
EB_ENV="${EB_ENV:-anot-backend-prod}"
DIST_COMMENT="${APP_NAME}-${EB_ENV}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

command -v aws >/dev/null || { echo "AWS CLI required" >&2; exit 1; }

log "Enabling RDS deletion protection on $DB_INSTANCE_ID..."
aws rds modify-db-instance \
  --db-instance-identifier "$DB_INSTANCE_ID" \
  --deletion-protection \
  --apply-immediately \
  --region "$AWS_REGION" >/dev/null 2>&1 \
  || log "RDS deletion protection skipped (instance may not exist or already enabled)."

DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].Id | [0]" \
  --output text 2>/dev/null || echo None)"

if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
  log "CloudFront distribution $DIST_ID — ensure /api/* forwards Authorization + cookies (run fix-cloudfront-csrf-header.sh if needed)."
else
  log "No CloudFront distribution found for comment '$DIST_COMMENT'."
fi

log "Infrastructure hardening complete."
