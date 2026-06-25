# Anot Health — Deployment Runbook

Standard operating procedure for deploying the Anot backend to AWS Elastic Beanstalk production.

| Item | Value |
|------|-------|
| AWS Account | `625242092266` |
| Region | `ap-southeast-1` |
| EB Application | `anot-backend` |
| EB Environment | `anot-backend-prod` |
| Production URL | `https://app.anot.health` |
| Health endpoint | `https://app.anot.health/api/health` |
| SSM prefix | `/anot/prod` |
| RDS instance | `anot-postgres` |

---

## 1. Pre-deployment steps

Run **every** check below before packaging or uploading a new version. If any check fails, **stop** — do not deploy.

### 1.1 Automated checklist (recommended)

From the **repository root** (Git Bash or WSL on Windows):

```bash
chmod +x scripts/pre-deploy-checklist.sh
./scripts/pre-deploy-checklist.sh
```

The script runs seven gates:

| # | Check | What it validates |
|---|-------|-------------------|
| 1 | `npm test` | All **71/71** unit tests pass |
| 2 | `npm run migrate` | SQL migrations apply cleanly against the target DB |
| 3 | `npm start` | Server boots without startup errors |
| 4 | `curl /api/health` | Local health returns **200 OK** with `status: "ok"` |
| 5 | SSM parameters | Required secrets exist under `/anot/prod` (see [SSM_PARAMETERS.md](./SSM_PARAMETERS.md)) |
| 6 | Database | Postgres connectivity via `.env` / `DATABASE_URL` |
| 7 | Deploy zip | `migrations/*.sql` and `scripts/run-migrations.js` are in the artifact |

**Local-only runs** (no AWS credentials):

```bash
SKIP_SSM=1 ./scripts/pre-deploy-checklist.sh
```

**Custom health port** (default reads `PORT`, usually `5000` locally):

```bash
PORT=5000 HEALTH_URL=http://127.0.0.1:5000/api/health ./scripts/pre-deploy-checklist.sh
```

### 1.2 Manual pre-flight (if scripts unavailable)

1. Confirm you are on the intended release branch / tag.
2. Review migration files in `anot-backend-main/anot-backend-main/migrations/` — destructive changes need a backup.
3. Verify SSM secrets: `aws ssm get-parameters-by-path --path /anot/prod --recursive --region ap-southeast-1`
4. Create an RDS snapshot if the release includes schema changes:
   ```bash
   aws rds create-db-snapshot \
     --db-instance-identifier anot-postgres \
     --db-snapshot-identifier "anot-pre-deploy-$(date +%Y%m%d-%H%M)" \
     --region ap-southeast-1
   ```

---

## 2. Deployment command

Deploy from the **backend project root** on Windows:

```powershell
cd anot-backend-main\anot-backend-main
powershell -File scripts\deploy-to-eb.ps1
```

Optional parameters:

```powershell
powershell -File scripts\deploy-to-eb.ps1 `
  -VersionPrefix v43 `
  -Region ap-southeast-1 `
  -HealthUrl https://app.anot.health/api/health `
  -WaitTimeoutSec 300
```

What the deploy script does:

1. Builds a Linux-compatible zip with `tar` (forward-slash paths — **never** `Compress-Archive`)
2. Uploads to the EB S3 bucket
3. Registers a new application version
4. Updates `anot-backend-prod`
5. Waits for EB **Ready / Green**
6. Verifies `GET /api/health` returns 200

**First deployment only** — set up CloudWatch alarms:

```bash
chmod +x scripts/setup-alarms.sh
ALERT_EMAIL=ops@anot.health ./scripts/setup-alarms.sh
```

---

## 3. Post-deployment verification

Run immediately after `deploy-to-eb.ps1` completes (or in CI):

```bash
chmod +x scripts/post-deploy-verification.sh
./scripts/post-deploy-verification.sh
```

The script polls `https://app.anot.health/api/health` for **5 minutes** (10 s interval).

| Outcome | Action |
|---------|--------|
| ✅ HTTP 200 + `status: "ok"` | Deployment successful — notify team in Slack |
| ❌ Timeout or non-200 | **Rollback** (see §4) |

Quick manual smoke test:

```bash
curl -sS https://app.anot.health/api/health
# Expected: {"status":"ok",...}

curl -sS -o /dev/null -w "%{http_code}\n" https://app.anot.health/api/csrf-token
# Expected: 200
```

Check EB console: environment health **Green**, version label matches the deploy.

---

## 4. Rollback procedure

Use when post-deploy verification fails, EB health is **Red**, or `/api/health` returns errors.

### 4.1 Fast rollback (previous EB version)

```powershell
$Region = 'ap-southeast-1'
$EbAppName = 'anot-backend'
$EbEnvName = 'anot-backend-prod'

# List recent versions (newest first)
aws elasticbeanstalk describe-application-versions `
  --application-name $EbAppName `
  --region $Region `
  --max-records 5 `
  --query 'ApplicationVersions[*].[VersionLabel,DateCreated]' `
  --output table

# Deploy the last known-good version label
$PreviousVersion = 'v42-YYYYMMDD-HHMMSS'   # <-- set this
aws elasticbeanstalk update-environment `
  --environment-name $EbEnvName `
  --version-label $PreviousVersion `
  --region $Region

aws elasticbeanstalk wait environment-updated `
  --application-name $EbAppName `
  --environment-names $EbEnvName `
  --region $Region
```

Then re-run post-deploy verification:

```bash
./scripts/post-deploy-verification.sh
```

### 4.2 SSM / secrets rollback

If the failure is SSM-related (missing parameters, wrong `USE_SSM` flag), follow [ROLLBACK_V40_SSM.md](../anot-backend-main/anot-backend-main/ROLLBACK_V40_SSM.md).

### 4.3 Database rollback

If a bad migration was applied:

1. Restore the pre-deploy RDS snapshot (see §1.2).
2. Roll back the EB application version.
3. Fix the migration locally, re-run pre-deploy checklist, redeploy.

**Never** run `seed:dev` or destructive SQL against production.

---

## 5. Emergency contact

| Role | Contact | When to escalate |
|------|---------|------------------|
| On-call engineering | `ops@anot.health` | Production down, rollback failed, data integrity concern |
| AWS account admin | Internal ops lead | IAM, RDS snapshot restore, EB platform issues |
| Security / HIPAA | `security@anot.health` | Suspected breach, PHI exposure, audit log tampering |

### Incident checklist

1. **Assess** — EB health, `/api/health`, CloudWatch alarms, RDS connections.
2. **Communicate** — Post in `#incidents` with time, version label, error symptoms.
3. **Mitigate** — Roll back EB version (§4.1) or disable traffic if health is critical.
4. **Verify** — `./scripts/post-deploy-verification.sh` after rollback.
5. **Document** — Root cause, timeline, and follow-up ticket within 24 h.

### Useful diagnostic commands

```bash
# EB environment status
aws elasticbeanstalk describe-environments \
  --application-names anot-backend \
  --environment-names anot-backend-prod \
  --region ap-southeast-1

# Recent EB events
aws elasticbeanstalk describe-events \
  --environment-name anot-backend-prod \
  --region ap-southeast-1 \
  --max-records 20

# CloudWatch alarms
aws cloudwatch describe-alarms \
  --alarm-name-prefix anot-prod \
  --region ap-southeast-1
```

---

## Related documentation

- [SSM_PARAMETERS.md](./SSM_PARAMETERS.md) — required Parameter Store paths
- [AWS_DEPLOYMENT.md](../deploy/AWS_DEPLOYMENT.md) — full AWS architecture guide
- [DEPLOYMENT_V40_SSM.md](../anot-backend-main/anot-backend-main/DEPLOYMENT_V40_SSM.md) — SSM bootstrap details
- [ROLLBACK_V40_SSM.md](../anot-backend-main/anot-backend-main/ROLLBACK_V40_SSM.md) — secrets rollback playbook
