# Anot Backend v40 — Rollback Plan

How to get back to a known-good state if the v40 / SSM deployment misbehaves.
Pick the section matching how far the deploy got. **Each rollback is independent
and safe to run on its own.**

| Item | Value |
| --- | --- |
| Account / Region | `625242092266` / `ap-southeast-1` |
| EB App / Env | `anot-backend` / `anot-backend-prod` |
| RDS | `anot-postgres` |
| Backups produced by Phase 2 | `backup-v39-*/eb-config-settings-v39.json`, `backup-v39-*/rds-snapshot-id.txt` |

> Set these once per shell:
> ```powershell
> $env:AWS_DEFAULT_REGION='ap-southeast-1'
> $EbAppName='anot-backend'; $EbEnvName='anot-backend-prod'; $RdsInstanceId='anot-postgres'
> ```

---

## Decision guide

| Symptom | Most likely cause | Go to |
| --- | --- | --- |
| App boots but Admin → Settings shows blank/garbage API keys | key mismatch / bad re-encrypt | **R3** then **R4** |
| Logs show `[loadSecrets] ❌ FATAL: SSM fetch failed` | IAM / param / region | **R2** (disable SSM) |
| Logs show `AccessDenied` on `ssm:GetParametersByPath` | IAM policy missing | re-run Phase 5, or **R1** |
| 5xx after Phase 11 (plaintext removed) | a needed secret isn't in SSM | **R1** (restore env props) |
| Health never reaches `v40` / crash loop | bad deploy | **R1** (redeploy v39) |
| Data corruption suspected | bad migration / write | **R4** (restore snapshot) — last resort |

---

## R1 — Fastest rollback: redeploy v39 + restore env properties

This returns the app to exactly the pre-deploy state (v39 reading secrets from EB
env properties). Use this if anything is broken and you want service back now.

```powershell
# 1. Roll the application version back to v39.
aws elasticbeanstalk update-environment `
  --application-name $EbAppName --environment-name $EbEnvName `
  --version-label v39
aws elasticbeanstalk wait environment-updated --application-name $EbAppName --environment-names $EbEnvName

# 2. Re-apply the saved v39 environment properties (only needed if Phase 11 ran).
#    Extract the secret OptionSettings from the backup and push them back.
$backup = Get-Content .\backup-v39-*\eb-config-settings-v39.json | ConvertFrom-Json
$opts = $backup.ConfigurationSettings[0].OptionSettings |
  Where-Object { $_.Namespace -eq 'aws:elasticbeanstalk:application:environment' }
$settings = $opts | ForEach-Object { "Namespace=$($_.Namespace),OptionName=$($_.OptionName),Value=$($_.Value)" }
aws elasticbeanstalk update-environment `
  --application-name $EbAppName --environment-name $EbEnvName `
  --option-settings $settings
aws elasticbeanstalk wait environment-updated --application-name $EbAppName --environment-names $EbEnvName
```

> Note: v39 uses the **OLD** `SETTINGS_ENCRYPTION_KEY`. If you already ran the
> LIVE re-encryption (Phase 6), the DB blobs are now on the **NEW** key, so v39
> will fail to decrypt them. In that case either keep v40, or run **R3** to
> rotate the blobs back to the OLD key before/while restoring v39.

---

## R2 — Keep v40 but disable SSM (boot from EB env props)

Use when the code is fine but SSM fetch/permissions are the problem and you want
to buy time without rolling the version back.

```powershell
aws elasticbeanstalk update-environment `
  --application-name $EbAppName --environment-name $EbEnvName `
  --option-settings "Namespace=aws:elasticbeanstalk:application:environment,OptionName=USE_SSM,Value=false"
aws elasticbeanstalk wait environment-updated --application-name $EbAppName --environment-names $EbEnvName
```

Then make sure the secrets still exist as EB env properties (restore them from
the backup as in **R1** step 2 if Phase 11 already removed them). With
`USE_SSM=false`, v40 behaves exactly like v39 w.r.t. secret loading.

> Alternative stop-gap: set `SSM_OPTIONAL=true` so a failed SSM fetch falls back
> to `.env`/EB props instead of exiting. Not recommended as a permanent state.

---

## R3 — Reverse the encryption-key rotation

If the re-encryption (Phase 6) is the issue (e.g. wrong NEW key deployed, or you
must return to v39 which holds the OLD key), rotate the blobs back. The script is
symmetric — just swap OLD/NEW.

```powershell
cd C:\Users\Administrator\Desktop\anot-health\anot-backend-main\anot-backend-main
# DB creds must point at PROD RDS (same DATABASE_URL the app uses).
$env:OLD_SETTINGS_ENCRYPTION_KEY = "<the NEW key currently in the DB>"
$env:NEW_SETTINGS_ENCRYPTION_KEY = "<the original OLD key>"
node scripts/reencrypt-settings-key.js --dry-run    # must succeed first
node scripts/reencrypt-settings-key.js              # transactional, commits
Remove-Item Env:OLD_SETTINGS_ENCRYPTION_KEY, Env:NEW_SETTINGS_ENCRYPTION_KEY
```

The script is all-or-nothing: if the "OLD" (current-in-DB) key can't decrypt a
blob, it ROLLBACKs and writes nothing — so a wrong guess is safe.

---

## R4 — Restore the RDS snapshot (last resort, data rollback)

Only if data is corrupted. This is **disruptive** (new endpoint / downtime).

```powershell
$SnapshotId = Get-Content .\backup-v39-*\rds-snapshot-id.txt
# Restore to a NEW instance, verify, then repoint the app (or swap names).
aws rds restore-db-instance-from-db-snapshot `
  --db-instance-identifier "$RdsInstanceId-restored" `
  --db-snapshot-identifier $SnapshotId
aws rds wait db-instance-available --db-instance-identifier "$RdsInstanceId-restored"
```

Then update `DATABASE_URL`/`DB_HOST` (in SSM or EB env) to the restored endpoint,
or rename instances during a maintenance window. Coordinate with the team — this
changes the connection target.

---

## Post-rollback verification

After any rollback:

```powershell
(Invoke-WebRequest -Uri 'https://api.anot.health/' -UseBasicParsing).Content   # expect healthy
(aws elasticbeanstalk describe-environments --application-name $EbAppName --environment-names $EbEnvName |
  ConvertFrom-Json).Environments[0] | Select-Object Health, VersionLabel
```

Manual checks:
- [ ] Login works (JWT_SECRET resolves).
- [ ] Admin → Settings shows the saved Deepgram/Anthropic keys (decryption key matches the DB blobs).
- [ ] AI note generation works.
- [ ] No `[loadSecrets] ❌ FATAL` or `Decryption failed` lines in the logs.

## Cleanup if you abandon SSM entirely

```powershell
# Remove the SSM params (optional) and the IAM policy.
aws ssm get-parameters-by-path --path /anot/prod --recursive --query 'Parameters[].Name' --output text |
  ForEach-Object { $_ -split '\s+' } | Where-Object { $_ } |
  ForEach-Object { aws ssm delete-parameter --name $_ }
aws iam delete-role-policy --role-name aws-elasticbeanstalk-ec2-role --policy-name anot-ssm-read-prod
```
