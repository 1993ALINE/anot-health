#!/usr/bin/env bash
# Remove secret values from Elastic Beanstalk environment properties.
# Secrets must live in SSM Parameter Store only (USE_SSM=true at boot).
#
# Usage (from repo root):
#   chmod +x deploy/aws/strip-eb-secrets.sh
#   AWS_REGION=ap-southeast-1 EB_ENV=anot-backend-prod ./deploy/aws/strip-eb-secrets.sh
#
# Safe to re-run. Does not delete SSM parameters.

set -euo pipefail

export AWS_REGION="${AWS_REGION:-ap-southeast-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
EB_ENV="${EB_ENV:-anot-backend-prod}"

SECRET_VARS=(
  JWT_SECRET
  DB_PASSWORD
  SETTINGS_ENCRYPTION_KEY
  ANTHROPIC_API_KEY
  DEEPGRAM_WEBHOOK_SECRET
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
)

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

command -v aws >/dev/null || { echo "AWS CLI required" >&2; exit 1; }

log "Stripping secret EB environment properties from '$EB_ENV'..."

OPTS_FILE="$(mktemp)"
{
  echo '['
  first=1
  for name in "${SECRET_VARS[@]}"; do
    if [ "$first" -eq 1 ]; then first=0; else echo ','; fi
    printf '  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"%s","Value":""}' "$name"
  done
  echo
  echo ']'
} > "$OPTS_FILE"

aws elasticbeanstalk update-environment \
  --environment-name "$EB_ENV" \
  --option-settings "file://$OPTS_FILE" >/dev/null

log "Waiting for environment update..."
aws elasticbeanstalk wait environment-updated --environment-names "$EB_ENV"

log "Verify in AWS Console → EB → $EB_ENV → Configuration → Software:"
log "  USE_SSM=true, SSM_PREFIX=/anot/prod — and NO JWT_SECRET / DB_PASSWORD values."
warn "If the app fails health checks, confirm SSM parameters exist under /anot/prod/* and IAM allows GetParametersByPath."
