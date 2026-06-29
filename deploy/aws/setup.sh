#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Anot — AWS one-shot setup (Free Tier friendly)
#
# Provisions everything needed to run Anot on AWS and deploys both apps:
#   1. S3 bucket for audio files (durable storage / backups).
#   2. RDS PostgreSQL (free-tier db.t3.micro, single-AZ, 20 GB) + security group.
#   3. Secrets stored in SSM Parameter Store (SecureString).
#   4. IAM roles for Elastic Beanstalk (instance profile + service role).
#   5. Backend deployed to Elastic Beanstalk (Node.js, SingleInstance, t3.micro).
#   6. Frontend built and deployed to S3 + CloudFront.
#      The same CloudFront distribution also fronts the backend at /api/*, so the
#      whole app is served over one HTTPS origin (no mixed-content, no CORS pain).
#
# Run from the repository ROOT on a machine with the AWS CLI v2, plus node/npm,
# zip and openssl (AWS CloudShell has all of these):
#   chmod +x deploy/aws/setup.sh
#   AWS_REGION=ap-southeast-1 ANTHROPIC_API_KEY=sk-ant-... ./deploy/aws/setup.sh
#
# Re-running is safe: existing resources are detected and reused where possible.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration (override via environment before running) ──────────────────
export AWS_REGION="${AWS_REGION:-ap-southeast-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
APP_NAME="${APP_NAME:-anot}"
SSM_PREFIX="${SSM_PREFIX:-/anot/prod}"

# Elastic Beanstalk (backend)
EB_APP="${EB_APP:-anot-backend}"
EB_ENV="${EB_ENV:-anot-backend-prod}"
EB_INSTANCE_TYPE="${EB_INSTANCE_TYPE:-t3.micro}"        # Free Tier eligible
EB_INSTANCE_PROFILE="${EB_INSTANCE_PROFILE:-aws-elasticbeanstalk-ec2-role}"
EB_SERVICE_ROLE="${EB_SERVICE_ROLE:-aws-elasticbeanstalk-service-role}"
# Pin a Node.js solution stack here to override auto-detection, e.g.:
# SOLUTION_STACK="64bit Amazon Linux 2023 v6.x.x running Node.js 20"
SOLUTION_STACK="${SOLUTION_STACK:-}"

# RDS (database)
DB_INSTANCE_ID="${DB_INSTANCE_ID:-anot-postgres}"
DB_CLASS="${DB_CLASS:-db.t3.micro}"                     # Free Tier eligible
DB_ALLOCATED="${DB_ALLOCATED:-20}"                      # GB (Free Tier: up to 20)
DB_NAME="${DB_NAME:-anot}"
DB_USER="${DB_USER:-anot_app}"                          # RDS master user == app user
DB_SG_NAME="${DB_SG_NAME:-anot-db-sg}"

# Directories
BACKEND_DIR="${BACKEND_DIR:-anot-backend-main/anot-backend-main}"
FRONTEND_DIR="${FRONTEND_DIR:-anot-frontend-main/anot-frontend-main}"
EBEXT_DIR="${EBEXT_DIR:-deploy/aws/ebextensions/.ebextensions}"

# Optional provider keys — read from env if present, else placeholders are stored.
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
DEEPGRAM_WEBHOOK_SECRET="${DEEPGRAM_WEBHOOK_SECRET:-}"

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v aws    >/dev/null || die "AWS CLI v2 not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
command -v node   >/dev/null || die "node not found (needed to build the frontend)."
command -v npm    >/dev/null || die "npm not found."
command -v zip    >/dev/null || die "zip not found."
command -v openssl>/dev/null || die "openssl not found."

aws sts get-caller-identity >/dev/null 2>&1 || die "AWS credentials not configured. Run: aws configure"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

AUDIO_BUCKET="${AUDIO_BUCKET:-${APP_NAME}-audio-${ACCOUNT_ID}}"
FRONTEND_BUCKET="${FRONTEND_BUCKET:-${APP_NAME}-frontend-${ACCOUNT_ID}}"

log "Account: $ACCOUNT_ID | Region: $AWS_REGION"
log "Audio bucket: $AUDIO_BUCKET | Frontend bucket: $FRONTEND_BUCKET"

# Default VPC (Elastic Beanstalk + RDS share it for private connectivity).
VPC_ID="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
[ "$VPC_ID" != "None" ] && [ -n "$VPC_ID" ] || die "No default VPC found in $AWS_REGION. Create one or set VPC handling manually."
VPC_CIDR="$(aws ec2 describe-vpcs --vpc-ids "$VPC_ID" --query 'Vpcs[0].CidrBlock' --output text)"
log "Default VPC: $VPC_ID ($VPC_CIDR)"

# Put a SecureString into SSM Parameter Store (idempotent: --overwrite).
ssm_put() {
  local name="$1" value="$2"
  aws ssm put-parameter --name "$name" --value "$value" --type SecureString --overwrite >/dev/null
}
ssm_get() { aws ssm get-parameter --name "$1" --with-decryption --query 'Parameter.Value' --output text; }
ssm_exists() { aws ssm get-parameter --name "$1" >/dev/null 2>&1; }

# ── 1. S3 bucket for audio files ─────────────────────────────────────────────
log "Ensuring S3 audio bucket: s3://$AUDIO_BUCKET"
if ! aws s3api head-bucket --bucket "$AUDIO_BUCKET" >/dev/null 2>&1; then
  aws s3api create-bucket --bucket "$AUDIO_BUCKET" \
    --region "$AWS_REGION" \
    --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
fi
# Audio is private; block all public access and turn on default encryption.
aws s3api put-public-access-block --bucket "$AUDIO_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
aws s3api put-bucket-encryption --bucket "$AUDIO_BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$AUDIO_BUCKET" \
  --lifecycle-configuration "file://${SCRIPT_DIR}/s3-audio-lifecycle.json" \
  --region "$AWS_REGION" >/dev/null
log "Applied 90-day audio lifecycle policy to s3://$AUDIO_BUCKET"

# ── 2. RDS PostgreSQL + security group ───────────────────────────────────────
log "Ensuring RDS security group '$DB_SG_NAME'..."
DB_SG_ID="$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=$DB_SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
if [ "$DB_SG_ID" = "None" ] || [ -z "$DB_SG_ID" ]; then
  DB_SG_ID="$(aws ec2 create-security-group \
    --group-name "$DB_SG_NAME" \
    --description "Anot RDS PostgreSQL access" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)"
fi
# Allow PostgreSQL from inside the VPC (the EB instance lives here). Tighten to
# the EB instance security group later for stricter access (see README).
aws ec2 authorize-security-group-ingress \
  --group-id "$DB_SG_ID" --protocol tcp --port 5432 --cidr "$VPC_CIDR" >/dev/null 2>&1 \
  || echo "  ingress rule already present."
log "RDS security group: $DB_SG_ID"

# DB password: reuse if already in SSM, else generate (kept only in SSM).
if ssm_exists "$SSM_PREFIX/DB_PASSWORD"; then
  DB_PASSWORD="$(ssm_get "$SSM_PREFIX/DB_PASSWORD")"
  echo "  reusing existing DB password from SSM."
else
  DB_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
  ssm_put "$SSM_PREFIX/DB_PASSWORD" "$DB_PASSWORD"
fi

log "Ensuring RDS instance '$DB_INSTANCE_ID' ($DB_CLASS)..."
if ! aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" >/dev/null 2>&1; then
  aws rds create-db-instance \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --db-instance-class "$DB_CLASS" \
    --engine postgres \
    --allocated-storage "$DB_ALLOCATED" \
    --storage-type gp2 \
    --master-username "$DB_USER" \
    --master-user-password "$DB_PASSWORD" \
    --db-name "$DB_NAME" \
    --vpc-security-group-ids "$DB_SG_ID" \
    --no-publicly-accessible \
    --no-multi-az \
    --backup-retention-period 7 \
    --storage-encrypted \
    --no-auto-minor-version-upgrade >/dev/null
  log "Waiting for RDS to become available (this can take ~5-10 minutes)..."
  aws rds wait db-instance-available --db-instance-identifier "$DB_INSTANCE_ID"
else
  echo "  instance already exists; ensuring it is available..."
  aws rds wait db-instance-available --db-instance-identifier "$DB_INSTANCE_ID"
fi

DB_HOST="$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"
log "RDS endpoint: $DB_HOST"

# ── 3. Secrets → SSM Parameter Store (/anot/prod/{VAR_NAME}) ─────────────────
log "Writing secrets to SSM Parameter Store under ${SSM_PREFIX}/ ..."
if ssm_exists "$SSM_PREFIX/JWT_SECRET"; then echo "  JWT_SECRET exists; keeping."; else ssm_put "$SSM_PREFIX/JWT_SECRET" "$(openssl rand -base64 48)"; fi
if ssm_exists "$SSM_PREFIX/SETTINGS_ENCRYPTION_KEY"; then echo "  SETTINGS_ENCRYPTION_KEY exists; keeping."; else ssm_put "$SSM_PREFIX/SETTINGS_ENCRYPTION_KEY" "$(openssl rand -hex 32)"; fi
ssm_put "$SSM_PREFIX/ANTHROPIC_API_KEY"            "${ANTHROPIC_API_KEY:-REPLACE_ME}"
ssm_put "$SSM_PREFIX/DEEPGRAM_WEBHOOK_SECRET"      "${DEEPGRAM_WEBHOOK_SECRET:-REPLACE_ME}"
ssm_put "$SSM_PREFIX/DB_HOST"                      "$DB_HOST"
[ -n "$ANTHROPIC_API_KEY" ] || warn "ANTHROPIC_API_KEY not provided — placeholder stored. Update with: aws ssm put-parameter --name ${SSM_PREFIX}/ANTHROPIC_API_KEY --type SecureString --overwrite --value sk-ant-..."

JWT_SECRET="$(ssm_get "$SSM_PREFIX/JWT_SECRET")"
SETTINGS_ENCRYPTION_KEY="$(ssm_get "$SSM_PREFIX/SETTINGS_ENCRYPTION_KEY")"
ANTHROPIC_KEY_VAL="$(ssm_get "$SSM_PREFIX/ANTHROPIC_API_KEY")"
DEEPGRAM_VAL="$(ssm_get "$SSM_PREFIX/DEEPGRAM_WEBHOOK_SECRET")"

# ── 4. IAM roles for Elastic Beanstalk ───────────────────────────────────────
log "Ensuring Elastic Beanstalk IAM roles..."

ensure_role() {
  local role="$1" trust="$2"; shift 2
  if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    aws iam create-role --role-name "$role" --assume-role-policy-document "$trust" >/dev/null
  fi
  for arn in "$@"; do
    aws iam attach-role-policy --role-name "$role" --policy-arn "$arn" >/dev/null 2>&1 || true
  done
}

EC2_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
EB_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"elasticbeanstalk.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

ensure_role "$EB_INSTANCE_PROFILE" "$EC2_TRUST" \
  arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier \
  arn:aws:iam::aws:policy/AWSElasticBeanstalkWorkerTier \
  arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess

ensure_role "$EB_SERVICE_ROLE" "$EB_TRUST" \
  arn:aws:iam::aws:policy/AWSElasticBeanstalkEnhancedHealth \
  arn:aws:iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy

# Instance profile wrapper for the EC2 role.
if ! aws iam get-instance-profile --instance-profile-name "$EB_INSTANCE_PROFILE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$EB_INSTANCE_PROFILE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$EB_INSTANCE_PROFILE" --role-name "$EB_INSTANCE_PROFILE" >/dev/null
fi

# Let the EB instance read/write the audio bucket (for syncing uploads to S3).
aws iam put-role-policy --role-name "$EB_INSTANCE_PROFILE" --policy-name anot-audio-s3 \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\",\"s3:ListBucket\"],\"Resource\":[\"arn:aws:s3:::$AUDIO_BUCKET\",\"arn:aws:s3:::$AUDIO_BUCKET/*\"]}]}" >/dev/null

# IAM is eventually consistent; give new roles a moment to propagate.
sleep 10

# ── 5. Deploy backend to Elastic Beanstalk ───────────────────────────────────
if [ -z "$SOLUTION_STACK" ]; then
  SOLUTION_STACK="$(aws elasticbeanstalk list-available-solution-stacks \
    --query "SolutionStacks[?contains(@, 'running Node.js')] | [0]" --output text)"
fi
[ -n "$SOLUTION_STACK" ] && [ "$SOLUTION_STACK" != "None" ] || die "Could not find a Node.js solution stack. Set SOLUTION_STACK manually."
log "Using solution stack: $SOLUTION_STACK"

# Package the backend: stage a copy, drop the monorepo-only dependency, add the
# .ebextensions, and zip it up.
log "Packaging backend bundle..."
STAGE="$(mktemp -d)"
cp -r "$BACKEND_DIR"/. "$STAGE"/
rm -rf "$STAGE/node_modules" "$STAGE/src/uploads" "$STAGE/.git"
find "$STAGE" -maxdepth 2 -name '.env' -delete 2>/dev/null || true
find "$STAGE" -maxdepth 2 -name '.env.*' ! -name '.env.example' -delete 2>/dev/null || true
# The `anot-workspace` (file:../..) dep is a monorepo link unused by the backend
# and cannot resolve on EB, so drop it before EB runs `npm install`.
( cd "$STAGE" && npm pkg delete dependencies.anot-workspace >/dev/null 2>&1 || true )
mkdir -p "$STAGE/.ebextensions"
cp "$EBEXT_DIR"/* "$STAGE/.ebextensions/"
BUNDLE="$(mktemp -d)/anot-backend.zip"
( cd "$STAGE" && zip -qr "$BUNDLE" . )
log "Bundle: $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"

# Upload the bundle to the EB storage bucket and register an application version.
EB_BUCKET="$(aws elasticbeanstalk create-storage-location --query S3Bucket --output text)"
VERSION_LABEL="manual-$(date +%Y%m%d-%H%M%S)"
S3_KEY="$EB_APP/$VERSION_LABEL.zip"
aws s3 cp "$BUNDLE" "s3://$EB_BUCKET/$S3_KEY" >/dev/null

aws elasticbeanstalk describe-applications --application-names "$EB_APP" \
  --query 'Applications[0].ApplicationName' --output text 2>/dev/null | grep -qx "$EB_APP" \
  || aws elasticbeanstalk create-application --application-name "$EB_APP" >/dev/null

aws elasticbeanstalk create-application-version \
  --application-name "$EB_APP" \
  --version-label "$VERSION_LABEL" \
  --source-bundle "S3Bucket=$EB_BUCKET,S3Key=$S3_KEY" \
  --process >/dev/null

# Build the option settings (env props + platform config) for create/update.
OPTS_FILE="$(mktemp)"
cat > "$OPTS_FILE" <<JSON
[
  {"Namespace":"aws:elasticbeanstalk:environment","OptionName":"EnvironmentType","Value":"SingleInstance"},
  {"Namespace":"aws:elasticbeanstalk:environment","OptionName":"ServiceRole","Value":"$EB_SERVICE_ROLE"},
  {"Namespace":"aws:autoscaling:launchconfiguration","OptionName":"IamInstanceProfile","Value":"$EB_INSTANCE_PROFILE"},
  {"Namespace":"aws:ec2:instances","OptionName":"InstanceTypes","Value":"$EB_INSTANCE_TYPE"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"NODE_ENV","Value":"production"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"USE_SSM","Value":"true"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"SSM_PREFIX","Value":"$SSM_PREFIX"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"SSM_REGION","Value":"$AWS_REGION"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"DB_HOST","Value":"$DB_HOST"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"DB_PORT","Value":"5432"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"DB_NAME","Value":"$DB_NAME"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"DB_USER","Value":"$DB_USER"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"DB_PASSWORD","Value":"$DB_PASSWORD"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"JWT_SECRET","Value":"$JWT_SECRET"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"JWT_EXPIRES_IN","Value":"8h"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"SETTINGS_ENCRYPTION_KEY","Value":"$SETTINGS_ENCRYPTION_KEY"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"ANTHROPIC_API_KEY","Value":"$ANTHROPIC_KEY_VAL"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"DEEPGRAM_WEBHOOK_SECRET","Value":"$DEEPGRAM_VAL"}
]
JSON

if aws elasticbeanstalk describe-environments --environment-names "$EB_ENV" \
    --query 'Environments[?Status!=`Terminated`].EnvironmentName' --output text 2>/dev/null | grep -qx "$EB_ENV"; then
  log "Updating existing Elastic Beanstalk environment '$EB_ENV'..."
  aws elasticbeanstalk update-environment \
    --environment-name "$EB_ENV" \
    --version-label "$VERSION_LABEL" \
    --option-settings "file://$OPTS_FILE" >/dev/null
else
  log "Creating Elastic Beanstalk environment '$EB_ENV'..."
  aws elasticbeanstalk create-environment \
    --application-name "$EB_APP" \
    --environment-name "$EB_ENV" \
    --solution-stack-name "$SOLUTION_STACK" \
    --version-label "$VERSION_LABEL" \
    --option-settings "file://$OPTS_FILE" >/dev/null
fi

log "Waiting for Elastic Beanstalk environment to be Ready (this can take several minutes)..."
while :; do
  STATUS="$(aws elasticbeanstalk describe-environments --environment-names "$EB_ENV" --query 'Environments[0].Status' --output text)"
  HEALTH="$(aws elasticbeanstalk describe-environments --environment-names "$EB_ENV" --query 'Environments[0].Health' --output text)"
  printf '  status=%s health=%s\n' "$STATUS" "$HEALTH"
  [ "$STATUS" = "Ready" ] && break
  [ "$STATUS" = "Terminated" ] && die "Environment terminated unexpectedly. Check the EB console/events."
  sleep 20
done

EB_CNAME="$(aws elasticbeanstalk describe-environments --environment-names "$EB_ENV" --query 'Environments[0].CNAME' --output text)"
log "Backend (Elastic Beanstalk) host: $EB_CNAME"

# ── 6. Frontend bucket (static website hosting) ──────────────────────────────
log "Ensuring frontend bucket: s3://$FRONTEND_BUCKET"
if ! aws s3api head-bucket --bucket "$FRONTEND_BUCKET" >/dev/null 2>&1; then
  aws s3api create-bucket --bucket "$FRONTEND_BUCKET" \
    --region "$AWS_REGION" \
    --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
fi
# Static asset bucket: allow public reads via bucket policy (assets only).
aws s3api put-public-access-block --bucket "$FRONTEND_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false >/dev/null
aws s3api put-bucket-website --bucket "$FRONTEND_BUCKET" \
  --website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"index.html"}}' >/dev/null
aws s3api put-bucket-policy --bucket "$FRONTEND_BUCKET" --policy \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PublicRead\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$FRONTEND_BUCKET/*\"}]}" >/dev/null

FRONTEND_WEBSITE_ENDPOINT="$FRONTEND_BUCKET.s3-website-$AWS_REGION.amazonaws.com"

# ── 7. CloudFront distribution (frontend default + /api/* → backend) ─────────
DIST_COMMENT="$APP_NAME-$EB_ENV"
DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].Id | [0]" --output text 2>/dev/null || echo None)"

if [ "$DIST_ID" = "None" ] || [ -z "$DIST_ID" ]; then
  log "Creating CloudFront distribution..."
  DIST_CONF="$(mktemp)"
  cat > "$DIST_CONF" <<JSON
{
  "CallerReference": "$APP_NAME-$(date +%s)",
  "Comment": "$DIST_COMMENT",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "Origins": {
    "Quantity": 2,
    "Items": [
      {
        "Id": "s3-frontend",
        "DomainName": "$FRONTEND_WEBSITE_ENDPOINT",
        "CustomOriginConfig": {
          "HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only",
          "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]}
        }
      },
      {
        "Id": "eb-backend",
        "DomainName": "$EB_CNAME",
        "CustomOriginConfig": {
          "HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only",
          "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]}
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-frontend",
    "ViewerProtocolPolicy": "redirect-to-https",
    "Compress": true,
    "AllowedMethods": {
      "Quantity": 3, "Items": ["GET", "HEAD", "OPTIONS"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}
    },
    "ForwardedValues": {
      "QueryString": false,
      "Cookies": {"Forward": "none"},
      "Headers": {"Quantity": 0}
    },
    "MinTTL": 0, "DefaultTTL": 3600, "MaxTTL": 86400
  },
  "CacheBehaviors": {
    "Quantity": 1,
    "Items": [
      {
        "PathPattern": "/api/*",
        "TargetOriginId": "eb-backend",
        "ViewerProtocolPolicy": "redirect-to-https",
        "Compress": false,
        "AllowedMethods": {
          "Quantity": 7, "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}
        },
        "ForwardedValues": {
          "QueryString": true,
          "Cookies": {"Forward": "all"},
          "Headers": {"Quantity": 5, "Items": ["Authorization", "Origin", "Content-Type", "Accept", "X-CSRF-Token"]}
        },
        "MinTTL": 0, "DefaultTTL": 0, "MaxTTL": 0
      }
    ]
  },
  "PriceClass": "PriceClass_All"
}
JSON
  DIST_ID="$(aws cloudfront create-distribution \
    --distribution-config "file://$DIST_CONF" \
    --query 'Distribution.Id' --output text)"
fi

DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)"
log "CloudFront distribution: $DIST_ID ($DIST_DOMAIN)"

# ── 8. Build + upload the frontend ───────────────────────────────────────────
log "Building frontend with VITE_API_URL=https://$DIST_DOMAIN/api ..."
(
  cd "$FRONTEND_DIR"
  npm install
  VITE_API_URL="https://$DIST_DOMAIN/api" npm run build
)
log "Uploading frontend to s3://$FRONTEND_BUCKET ..."
aws s3 sync "$FRONTEND_DIR/dist" "s3://$FRONTEND_BUCKET" --delete >/dev/null
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' >/dev/null

# ── 9. Lock CORS to the CloudFront origin ────────────────────────────────────
log "Setting CORS_ORIGINS=https://$DIST_DOMAIN on the backend..."
CORS_OPTS="$(mktemp)"
cat > "$CORS_OPTS" <<JSON
[{"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"CORS_ORIGINS","Value":"https://$DIST_DOMAIN"}]
JSON
aws elasticbeanstalk update-environment --environment-name "$EB_ENV" --option-settings "file://$CORS_OPTS" >/dev/null

# ── Done ─────────────────────────────────────────────────────────────────────
warn "Remember to apply DB migrations from $BACKEND_DIR/migrations/ (see README step 'Database migrations')."
cat <<DONE

────────────────────────────────────────────────────────────────────────────
 Anot is deploying on AWS ($AWS_REGION).

   Frontend + API : https://$DIST_DOMAIN
   API base URL   : https://$DIST_DOMAIN/api
   Backend (EB)   : http://$EB_CNAME   (direct; used by health checks)
   Database (RDS) : $DB_HOST:5432/$DB_NAME  (user: $DB_USER)
   Audio bucket   : s3://$AUDIO_BUCKET
   Frontend bucket: s3://$FRONTEND_BUCKET

 CloudFront takes ~10-20 minutes to finish its first deployment. The EB
 environment may report degraded health until DB migrations are applied.

 Next: apply migrations (README), then open https://$DIST_DOMAIN and log in.
────────────────────────────────────────────────────────────────────────────
DONE
