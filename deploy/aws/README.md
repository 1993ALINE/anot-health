# Anot — AWS Deployment Guide

Deploy the Anot **backend** to **Elastic Beanstalk** (Node.js on Amazon Linux
2023, backed by **RDS for PostgreSQL**, with an **S3** bucket for audio) and the
**frontend** to **S3 + CloudFront**.

Everything is scripted for the **AWS Free Tier** in **`ap-southeast-1` (Singapore)**.
Once your AWS account is ready you can run one script and be live in ~30 minutes
(most of that is RDS provisioning).

---

## Architecture

```
                         ┌──────────────────────────────┐
   Browser ───── HTTPS ─▶│        CloudFront (CDN)        │
                         │  default behavior  →  S3 (SPA) │  static Vite/React build (dist/)
                         │  /api/*            →  EB (API) │
                         └───────────────┬────────────────┘
                                         │ http (origin)
                                         ▼
                         ┌──────────────────────────────┐     private VPC (5432)
                         │  Elastic Beanstalk (backend)  │ ───────────────────────▶  RDS
                         │  Node 20 + nginx + ffmpeg     │                          PostgreSQL
                         │  SingleInstance t3.micro      │ ── local disk ──▶ src/uploads
                         └──────────────────────────────┘                   (audio files)
                                                                S3 bucket (durable audio store)
```

Why these choices:
- **One CloudFront distribution** fronts *both* the SPA and the API (`/api/*` →
  Elastic Beanstalk). The frontend and backend therefore share a single HTTPS
  origin, which avoids **mixed-content** errors (an HTTPS page can't call an
  HTTP backend) and makes CORS effectively a no-op. The Vite build is pointed at
  `https://<dist>.cloudfront.net/api`.
- **Elastic Beanstalk** (SingleInstance, `t3.micro`) runs the existing app
  unchanged — `npm start` → `node src/server.js`, reading `process.env.PORT`
  (EB sets `8080` and proxies nginx → app). No load balancer = no hourly LB cost.
- **RDS PostgreSQL** lives in the same default VPC and is reached privately over
  port 5432, so no public IP/SSL config is needed (mirrors the private path used
  on Google Cloud). `src/config/db.js` already supports discrete `DB_*` vars.
- **ffmpeg** is installed on the instance by `.ebextensions` (the backend spawns
  the `ffmpeg` binary for audio preprocessing).
- **Audio uploads** are written to the instance's local disk at `src/uploads`,
  which persists across in-place deploys on a single instance. The **S3 bucket**
  is provisioned for durable storage/backups and the instance role is granted
  access to it (for syncing or a future S3 storage backend).

---

## Files in this folder

| File | Purpose |
|------|---------|
| `setup.sh` | One-shot provisioning + deploy (S3, RDS, SSM secrets, IAM, Elastic Beanstalk, CloudFront). |
| `ebextensions/.ebextensions/nodejs.config` | Elastic Beanstalk config (SingleInstance, t3.micro, nginx, ffmpeg install). Copied into the bundle root at deploy time. |
| `env.production.example` | Every production env var, with notes on which are secrets. |
| `README.md` | This guide. |

---

## Prerequisites

- An AWS account (Free Tier is fine) with permissions to create S3, RDS, EC2/
  Elastic Beanstalk, IAM, SSM, and CloudFront resources.
- One of:
  - **AWS CloudShell** (recommended — `aws`, `node`, `npm`, `zip`, `openssl` are preinstalled), or
  - A local machine with the **AWS CLI v2**, `node` 20+, `npm`, `zip`, and `openssl`.
- Your `ANTHROPIC_API_KEY` (and optionally `DEEPGRAM_WEBHOOK_SECRET`).

> The setup script is **bash**. On Windows, run it from **AWS CloudShell**, **WSL**, or **Git Bash**.

---

## Fast path (≈30 minutes)

From the **repository root**:

```bash
# 1. Authenticate (skip in CloudShell — credentials are already present)
aws configure   # set your access key, secret, and default region ap-southeast-1

# 2. Provide your provider key(s) so they go straight into SSM Parameter Store
export ANTHROPIC_API_KEY="sk-ant-..."
# export DEEPGRAM_WEBHOOK_SECRET="..."   # optional

# 3. Run the whole thing
chmod +x deploy/aws/setup.sh
AWS_REGION=ap-southeast-1 ./deploy/aws/setup.sh
```

When it finishes it prints the **CloudFront URL** (frontend + API), the **backend
EB host**, and the **RDS endpoint**. The only manual step is applying database
migrations (see below).

---

## What `setup.sh` does (step by step)

### 1. S3 bucket for audio
Creates `s3://<app>-audio-<account-id>` with **all public access blocked** and
AES-256 default encryption. Used for durable audio storage/backups.

### 2. RDS PostgreSQL + security group
Creates a security group (`anot-db-sg`) that allows port 5432 from inside the
VPC, then creates a **`db.t3.micro`**, single-AZ, 20 GB, encrypted PostgreSQL
instance (`anot-postgres`). The RDS **master user is `anot_app`** (so it doubles
as the app user) and owns the `anot` database. The generated password is stored
**only** in SSM Parameter Store (`/anot/db-password`).

### 3. Secrets (SSM Parameter Store)
Creates/uses SecureString parameters: `/anot/jwt-secret`,
`/anot/settings-encryption-key`, `/anot/anthropic-key`,
`/anot/deepgram-webhook-secret`, `/anot/db-password`. The JWT secret and
encryption key are auto-generated with `openssl` if absent.

### 4. IAM roles
Ensures the EB **instance profile** (`aws-elasticbeanstalk-ec2-role`, with the
Web/Worker tier policies + an inline policy for the audio bucket) and the EB
**service role** (`aws-elasticbeanstalk-service-role`, for enhanced health).

### 5. Deploy backend to Elastic Beanstalk
Packages the backend (dropping the monorepo-only `anot-workspace` dependency and
adding `.ebextensions`), uploads it as an application version, and creates a
**SingleInstance `t3.micro`** environment on the latest **Node.js** solution
stack. All non-CORS env vars (DB connection + secrets) are injected as
environment properties at creation so the app boots cleanly.

### 6. Frontend bucket
Creates `s3://<app>-frontend-<account-id>`, enables **static website hosting**
(error document `index.html` for SPA deep links), and attaches a public-read
bucket policy (static assets only).

### 7. CloudFront distribution
Creates a distribution with two origins:
- **default behavior** → the frontend S3 website endpoint (the SPA),
- **`/api/*`** → the Elastic Beanstalk backend (no caching, forwards
  `Authorization`/cookies/query string).

Viewer protocol is **redirect-to-HTTPS**, so the whole app is HTTPS.

### 8. Build + upload the frontend
Builds the Vite app with `VITE_API_URL=https://<dist>.cloudfront.net/api`, syncs
`dist/` to the frontend bucket, and issues a CloudFront invalidation.

### 9. Lock CORS
Sets `CORS_ORIGINS=https://<dist>.cloudfront.net` on the backend.

---

## Database migrations  ⚠️ run once

SQL migrations live in `anot-backend-main/migrations/*.sql` and
must be applied in filename order. RDS is **not publicly accessible**, so run
them from inside the VPC. Two easy options:

**Option A — SSH into the EB instance** (it's already in the VPC and has `psql`
available if you install it, or use `node`):

```bash
# Install the EB CLI once: pip install awsebcli
cd anot-backend-main
eb ssh anot-backend-prod        # opens a shell on the instance
# then, on the instance:
sudo dnf install -y postgresql15   # client only
cd /var/app/current
for f in $(ls migrations/*.sql | sort); do
  echo "Applying $f"
  PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "$f"
done
```

**Option B — temporarily expose RDS to your IP** (revert afterwards):

```bash
DB_INSTANCE_ID=anot-postgres
MYIP=$(curl -s https://checkip.amazonaws.com)
SG=$(aws rds describe-db-instances --db-instance-identifier $DB_INSTANCE_ID \
  --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)
aws rds modify-db-instance --db-instance-identifier $DB_INSTANCE_ID --publicly-accessible --apply-immediately
aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 5432 --cidr ${MYIP}/32

HOST=$(aws rds describe-db-instances --db-instance-identifier $DB_INSTANCE_ID --query 'DBInstances[0].Endpoint.Address' --output text)
PASS=$(aws ssm get-parameter --name /anot/db-password --with-decryption --query 'Parameter.Value' --output text)
cd anot-backend-main
for f in $(ls migrations/*.sql | sort); do
  echo "Applying $f"; PGPASSWORD="$PASS" psql "sslmode=require host=$HOST user=anot_app dbname=anot" -f "$f"
done

# revert
aws ec2 revoke-security-group-ingress --group-id $SG --protocol tcp --port 5432 --cidr ${MYIP}/32
aws rds modify-db-instance --db-instance-identifier $DB_INSTANCE_ID --no-publicly-accessible --apply-immediately
```

---

## Audio retention — PHI lifecycle  ⚠️ apply once

Encounter audio (PHI) is stored in the audio S3 bucket under the `uploads/`
prefix. The app only deletes an object when its visit is deleted, so without a
bucket lifecycle rule audio would be retained indefinitely. The PHI awareness
training shown to every user states audio is **deleted after 90 days**, so this
rule must be applied for that statement to hold true.

Apply the rule in [`s3-audio-lifecycle.json`](./s3-audio-lifecycle.json) to the
audio bucket (objects expire 90 days after creation):

```bash
AUDIO_BUCKET="anot-audio-$(aws sts get-caller-identity --query Account --output text)"
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$AUDIO_BUCKET" \
  --lifecycle-configuration file://deploy/aws/s3-audio-lifecycle.json

# Verify
aws s3api get-bucket-lifecycle-configuration --bucket "$AUDIO_BUCKET"
```

To change or remove the retention window, edit `Expiration.Days` in the JSON and
re-apply, or `aws s3api delete-bucket-lifecycle --bucket "$AUDIO_BUCKET"`.

---

## Manual / CI deploys

**Backend only** (after the first full setup) — repackage and push a new version:

```bash
APP=anot-backend ENV=anot-backend-prod
STAGE=$(mktemp -d)
cp -r anot-backend-main/. "$STAGE"/
rm -rf "$STAGE/node_modules" "$STAGE/src/uploads"
( cd "$STAGE" && npm pkg delete dependencies.anot-workspace )
mkdir -p "$STAGE/.ebextensions" && cp deploy/aws/ebextensions/.ebextensions/* "$STAGE/.ebextensions/"
( cd "$STAGE" && zip -qr /tmp/anot-backend.zip . )

BUCKET=$(aws elasticbeanstalk create-storage-location --query S3Bucket --output text)
VER="manual-$(date +%Y%m%d-%H%M%S)"
aws s3 cp /tmp/anot-backend.zip "s3://$BUCKET/$APP/$VER.zip"
aws elasticbeanstalk create-application-version --application-name "$APP" --version-label "$VER" \
  --source-bundle "S3Bucket=$BUCKET,S3Key=$APP/$VER.zip" --process
aws elasticbeanstalk update-environment --environment-name "$ENV" --version-label "$VER"
```

**Frontend only:**

```bash
DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='anot-anot-backend-prod'].Id | [0]" --output text)
DOMAIN=$(aws cloudfront get-distribution --id "$DIST" --query 'Distribution.DomainName' --output text)
cd anot-frontend-main
VITE_API_URL="https://$DOMAIN/api" npm run build
aws s3 sync dist "s3://anot-frontend-$(aws sts get-caller-identity --query Account --output text)" --delete
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*'
```

---

## Configuration reference

All variables and which are secrets are documented in
[`env.production.example`](./env.production.example). Override `setup.sh`
defaults by exporting them first, e.g.:

```bash
AWS_REGION=ap-southeast-1 DB_CLASS=db.t3.small EB_INSTANCE_TYPE=t3.small \
  ./deploy/aws/setup.sh
```

Update a secret later and redeploy to pick it up:

```bash
aws ssm put-parameter --name /anot/anthropic-key --type SecureString --overwrite --value 'sk-ant-NEWKEY'
# Re-set the EB env property from SSM (EB env props are a snapshot, not live):
VAL=$(aws ssm get-parameter --name /anot/anthropic-key --with-decryption --query 'Parameter.Value' --output text)
aws elasticbeanstalk update-environment --environment-name anot-backend-prod \
  --option-settings "Namespace=aws:elasticbeanstalk:application:environment,OptionName=ANTHROPIC_API_KEY,Value=$VAL"
```

---

## Verify

```bash
# Backend health check (should return the "Anot API is running" JSON)
EB_CNAME=$(aws elasticbeanstalk describe-environments --environment-names anot-backend-prod --query 'Environments[0].CNAME' --output text)
curl -s "http://$EB_CNAME/"

# Through CloudFront (HTTPS, once the distribution finishes deploying)
DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='anot-anot-backend-prod'].Id | [0]" --output text)
DOMAIN=$(aws cloudfront get-distribution --id "$DIST" --query 'Distribution.DomainName' --output text)
curl -s "https://$DOMAIN/api/"   # routed to the backend

# Tail backend logs
eb logs anot-backend-prod        # or: aws elasticbeanstalk request-environment-info / retrieve-environment-info
```

Open `https://<dist>.cloudfront.net` and log in.

---

## Cost notes (Free Tier)

- **Elastic Beanstalk** itself is free; you pay for the **`t3.micro` EC2**
  instance (750 hrs/month free for 12 months). `SingleInstance` means **no load
  balancer** (which would otherwise be a fixed hourly cost).
- **RDS `db.t3.micro`** is Free Tier eligible (750 hrs/month + 20 GB for 12
  months) and runs continuously. For demos, stop it when idle:
  `aws rds stop-db-instance --db-instance-identifier anot-postgres`
  (RDS auto-starts stopped instances after 7 days).
- **S3** is billed by stored volume + requests (Free Tier: 5 GB).
- **CloudFront** Free Tier includes 1 TB egress + 10M requests/month.

---

## Hardening (recommended before real traffic)

- **Tighten the RDS security group** to allow 5432 only from the EB instance's
  security group instead of the whole VPC CIDR:
  ```bash
  EBSG=$(aws elasticbeanstalk describe-environment-resources --environment-name anot-backend-prod \
    --query 'EnvironmentResources.Instances[0].Id' --output text \
    | xargs -I{} aws ec2 describe-instances --instance-ids {} \
    --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)
  DBSG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=anot-db-sg --query 'SecurityGroups[0].GroupId' --output text)
  aws ec2 authorize-security-group-ingress --group-id $DBSG --protocol tcp --port 5432 --source-group $EBSG
  aws ec2 revoke-security-group-ingress  --group-id $DBSG --protocol tcp --port 5432 --cidr <your-vpc-cidr>
  ```
- **Secrets:** EB environment properties are visible in plaintext in the EB
  console. For stricter handling, read them from SSM/Secrets Manager at runtime
  instead of injecting them as env properties.
- **Audio durability:** sync `src/uploads` to the S3 bucket (the instance role
  already has access) or wire up an S3 storage backend so audio survives an
  instance replacement.
- **Custom domain + TLS:** attach an ACM certificate and your domain to the
  CloudFront distribution.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `JWT_SECRET is required` / app crash-loops | Ensure the EB env properties include `JWT_SECRET` (≥16 chars). Re-run `setup.sh` or set it via `update-environment`. |
| `Database connection failed at startup` | Check the EB `DB_HOST` matches the RDS endpoint and `anot-db-sg` allows 5432 from the VPC. RDS must be `available`. |
| `npm install` fails on EB referencing `anot-workspace` | The bundle must have that dependency stripped — `setup.sh` does this; for manual deploys run `npm pkg delete dependencies.anot-workspace` before zipping. |
| Audio fails / `ffmpeg not found` | Confirm the `.ebextensions/nodejs.config` ran (check EB deploy logs); it installs a static ffmpeg into `/usr/local/bin`. |
| Mixed-content / CORS errors in browser | Make sure the frontend was built with `VITE_API_URL=https://<dist>.cloudfront.net/api` and `CORS_ORIGINS` includes the CloudFront domain. |
| Login returns **403** with valid CSRF cookie + header in browser | CloudFront `/api/*` must forward `X-CSRF-Token` to Elastic Beanstalk. Run `./fix-cloudfront-csrf-header.sh` (see `setup.sh` for new distributions). |
| 404 on frontend deep links | The frontend bucket's website error document must be `index.html` (set by `setup.sh`). |
| CloudFront returns stale assets | Invalidate: `aws cloudfront create-invalidation --distribution-id <id> --paths '/*'`. |
