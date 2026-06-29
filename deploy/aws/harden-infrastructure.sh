#!/usr/bin/env bash
# Apply production infrastructure hardening (idempotent).
#   - RDS: Multi-AZ + deletion protection
#   - EB: strip plaintext secrets (SSM-only)
#   - CloudWatch: production alarms
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

log "Enabling RDS Multi-AZ and deletion protection on $DB_INSTANCE_ID..."
aws rds modify-db-instance \
  --db-instance-identifier "$DB_INSTANCE_ID" \
  --multi-az \
  --deletion-protection \
  --apply-immediately \
  --region "$AWS_REGION" >/dev/null 2>&1 \
  || log "RDS hardening skipped (instance may not exist or already configured)."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -x "$SCRIPT_DIR/strip-eb-secrets.sh" ]; then
  log "Removing plaintext secrets from EB environment '$EB_ENV'..."
  EB_ENV="$EB_ENV" AWS_REGION="$AWS_REGION" "$SCRIPT_DIR/strip-eb-secrets.sh" || \
    log "EB secret strip skipped (environment may not exist)."
fi

if [ -x "$REPO_ROOT/scripts/setup-alarms.sh" ]; then
  log "Configuring CloudWatch production alarms..."
  EB_ENV_NAME="$EB_ENV" AWS_REGION="$AWS_REGION" "$REPO_ROOT/scripts/setup-alarms.sh" || \
    log "Alarm setup failed — run scripts/setup-alarms.sh manually."
fi

DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].Id | [0]" \
  --output text 2>/dev/null || echo None)"

if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
  log "CloudFront distribution $DIST_ID — ensure /api/* forwards Authorization + cookies (run fix-cloudfront-csrf-header.sh if needed)."
else
  log "No CloudFront distribution found for comment '$DIST_COMMENT'."
fi

log "Infrastructure hardening complete."
