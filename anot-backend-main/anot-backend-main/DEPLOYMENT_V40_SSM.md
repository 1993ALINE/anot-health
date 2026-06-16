# Anot Backend v40 — SSM Secrets Deployment Guide

Moves all production secrets out of Elastic Beanstalk environment properties and
into **AWS SSM Parameter Store** (encrypted SecureStrings), loaded at boot by
`src/config/loadSecrets.js`. Local development is unchanged (`.env` is still used
when `USE_SSM` is not `true`).

| Item | Value |
| --- | --- |
| AWS Account | `625242092266` |
| Region | `ap-southeast-1` |
| SSM Prefix | `/anot/prod` |
| EB Application | `anot-backend` |
| RDS Instance | `anot-postgres` |
| Version | `v39` → `v40` |
| Script | `scripts/deploy-v40-ssm.ps1` |
| Rollback | `ROLLBACK_V40_SSM.md` |

---

## What changed in the code

| File | Change |
| --- | --- |
| `src/config/loadSecrets.js` | **New.** Async SSM bootstrap. `USE_SSM=true` → fetch + decrypt every param under `/anot/prod` into `process.env`. Otherwise no-op (uses `.env`). |
| `src/server.js` | Wrapped startup in `bootstrap()` that `await loadSecrets()` **before** requiring `instrument.js` and `./config/db` (both read `process.env` at import time). Health version → `v40`. |
| `package.json` | Added `@aws-sdk/client-ssm`; version `1.40.0`; `reencrypt:settings-key` script. |
| `scripts/reencrypt-settings-key.js` | **New.** Transactional rotation of `SETTINGS_ENCRYPTION_KEY` (decrypt-old → re-encrypt-new → verify → commit). |
| `.env.example` | Documented `USE_SSM`, `SSM_REGION`, `SSM_PREFIX`, `SSM_OPTIONAL`, `SSM_NO_OVERRIDE`. |

### Boot ordering (the critical invariant)

`./config/db` opens the Postgres pool the instant it is `require`d, and
`instrument.js` reads `SENTRY_DSN` on require. So `server.js` does:

```
bootstrap()  ->  await loadSecrets()  ->  require('instrument')  ->  require('./config/db')  ->  build app  ->  listen
```

If you ever add a new module that reads `process.env` at import time, require it
**inside** `bootstrap()` after `await loadSecrets()`.

---

## Environment variables (v40)

| Var | Default | Purpose |
| --- | --- | --- |
| `USE_SSM` | `false` | `true` enables the SSM fetch. Set on the EB env. |
| `SSM_REGION` | `AWS_REGION` or `ap-southeast-1` | Region for the SSM client. |
| `SSM_PREFIX` | `/anot/prod` | Path prefix fetched recursively. |
| `SSM_OPTIONAL` | `false` | `true` → boot from `.env` if SSM fails (NOT for prod). |
| `SSM_NO_OVERRIDE` | `false` | `true` → keep pre-set env vars instead of SSM values. |

Parameter naming: the leaf segment becomes the env var, e.g.
`/anot/prod/DB_PASSWORD` → `process.env.DB_PASSWORD`.

---

## Deployment phases (with wait times)

Run `scripts/deploy-v40-ssm.ps1` block-by-block. **Edit the CONFIG region at the
top first** (especially `$EbEnvName` and `$HealthUrl`).

The script runs **BACKUP + 8 phases (Phases 0–8)**, preceded by a read-only
PRE-FLIGHT check.

| Phase | What | Approx wait | Reversible? |
| --- | --- | --- | --- |
| PRE-FLIGHT | Tooling + identity + EB/RDS/health checks | ~1 min | n/a (read-only) |
| BACKUP | Export EB config + create RDS snapshot | **5–10 min** (snapshot) | n/a |
| 0 | IAM: grant EB instance role `ssm:GetParametersByPath` + `kms:Decrypt` | ~1 min | remove policy |
| 1 | Prepare secret values (generate DB password / `JWT_SECRET` / webhook secret; **reuse** the existing `SETTINGS_ENCRYPTION_KEY`) | ~10 s | n/a (in memory) |
| 2 | Build v40 artifact (`npm install`, tar zip) + register app version | ~2–3 min | n/a |
| 3 | Rotate the RDS master password (applied immediately) | **5–10 min** | restore snapshot / reset password |
| 4 | Put all secrets into SSM SecureStrings | ~2 min | delete params |
| 5 | Verify required secrets exist in SSM (deploy **gate**) | ~1 min | n/a (read-only) |
| 6 | Enable `USE_SSM=true` **and** deploy v40 (one atomic env update) | ~3–5 min | redeploy v39 / set `false` |
| 7 | Verify v40 health — endpoint reports `v40` + EB `Green` (**gate**) | ~2 min | n/a |
| 8 | Remove plaintext secrets from EB env props (**only if Phase 7 passed**) | ~2–3 min | re-add via `restore-v39-secrets.ps1` |

**Total: ~30–45 minutes**, most of it the RDS snapshot (BACKUP) and the RDS
password rotation (Phase 3).

> **`SETTINGS_ENCRYPTION_KEY` is NOT rotated by this deploy.** Phase 1 copies the
> existing key into SSM unchanged so the encrypted `system_settings` blobs stay
> decryptable. Rotating that key is a **separate** operation —
> `scripts/reencrypt-settings-key.js` (dry-run → live) — and is **not** part of
> `deploy-v40-ssm.ps1`. See "Rotating the settings key" below.

### Ordering rationale (why this sequence is safe)

1. **Backup before any change** (BACKUP) — the RDS snapshot + EB config export
   are the rollback base; nothing destructive runs until they exist.
2. **Build before destructive changes** (Phase 2) — `npm install` / zip can fail,
   so we fail BEFORE rotating the DB password or writing SSM; a bad build never
   leaves prod half-migrated.
3. **Rotate DB password, then store secrets** (Phases 3–4) — the new
   `DB_PASSWORD` / `DATABASE_URL` are written to SSM alongside the rest.
4. **Verify SSM before deploy** (Phase 5) — refuse to deploy v40 unless every
   required secret is already present in SSM.
5. **Enable SSM and deploy atomically** (Phase 6) — `USE_SSM=true` and the v40
   version ship in a single `update-environment`, so v40 boots with SSM on and
   reads the rotated password on first boot. There is no window where v40 runs
   without SSM.
6. **Health gate before removing plaintext** (Phase 7) — confirm v40 is actually
   live (endpoint reports `v40`) and EB is `Green` first.
7. **Remove plaintext last** (Phase 8) — only after Phase 7 passes, so a failure
   at any earlier point still has the EB env-property fallback (restore it with
   `restore-v39-secrets.ps1`).

---

## Testing checklist (verify each phase)

- **PRE-FLIGHT** — `aws sts get-caller-identity` shows account `625242092266`; EB
  env health is `Green`; RDS status `available`; health URL returns JSON.
- **BACKUP** — `backup-v39-*/eb-config-settings-v39.json` exists and is
  non-empty; `backup-v39-*/rds-snapshot-id.txt` exists and
  `aws rds describe-db-snapshots --db-snapshot-identifier <id>` shows
  `available`.
- **Phase 0** — `aws iam get-role-policy --role-name aws-elasticbeanstalk-ec2-role
  --policy-name anot-ssm-read-prod` returns the policy.
- **Phase 1** — console prints `All secret values prepared.` and reports the
  existing `SETTINGS_ENCRYPTION_KEY` was reused (not regenerated). Values live in
  memory only and are never echoed.
- **Phase 2** — `dist/anot-backend-v40.zip` exists; the script confirms the
  archive uses forward-slash (Unix) paths; `package.json` shows
  `@aws-sdk/client-ssm` and `1.40.0`.
- **Phase 3** — after the rotation, `aws rds describe-db-instances
  --db-instance-identifier anot-postgres` shows `DBInstanceStatus: available`.
- **Phase 4** — `aws ssm get-parameters-by-path --path /anot/prod --recursive
  --query 'Parameters[].Name'` lists every expected secret name.
- **Phase 5** — the gate prints all required secrets present; it aborts BEFORE
  deploy if any of `JWT_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `DB_PASSWORD`,
  `DATABASE_URL`, `ANTHROPIC_API_KEY` is missing.
- **Phase 6** — `describe-configuration-settings` shows `USE_SSM=true`;
  environment `VersionLabel` is `v40`, health `Green`; **EB logs contain
  `[loadSecrets] ✅ Loaded N parameter(s) from SSM`**.
- **Phase 7** — health endpoint returns `"version":"v40"`; you can log in (new
  `JWT_SECRET` from SSM); Admin → Settings shows the saved Deepgram/Anthropic
  keys (proves the preserved settings key still decrypts the blobs); generating
  an AI note works (`ANTHROPIC_API_KEY` from SSM).
- **Phase 8** — after env props removed and the env restarts, health still
  returns `v40` and login still works (proves the app is fully SSM-sourced).

### Quick log check

```powershell
aws elasticbeanstalk request-environment-info --environment-name $EbEnvName --info-type tail
Start-Sleep 20
aws elasticbeanstalk retrieve-environment-info --environment-name $EbEnvName --info-type tail
# look for: [loadSecrets] ✅ Loaded N parameter(s) from SSM
```

---

## Rotating the settings key (separate operation, NOT part of the deploy)

`deploy-v40-ssm.ps1` deliberately does **not** rotate `SETTINGS_ENCRYPTION_KEY` —
doing so without re-encrypting the ciphertext would orphan every encrypted value
in `system_settings` (saved Deepgram/Anthropic keys). To rotate it, run the
transactional re-encryption script against prod **before** putting the NEW key
into SSM:

```powershell
cd C:\Users\Administrator\Desktop\anot-health\anot-backend-main\anot-backend-main
# DB creds must point at PROD RDS (same DATABASE_URL the app uses).
$env:OLD_SETTINGS_ENCRYPTION_KEY = "<current key in the DB>"
$env:NEW_SETTINGS_ENCRYPTION_KEY = "<the new key>"
node scripts/reencrypt-settings-key.js --dry-run    # prints "would have re-encrypted N/N blob(s)"
node scripts/reencrypt-settings-key.js              # transactional; prints "Done. Committed N"
Remove-Item Env:OLD_SETTINGS_ENCRYPTION_KEY, Env:NEW_SETTINGS_ENCRYPTION_KEY
```

The script is all-or-nothing: if the OLD key can't decrypt a blob it ROLLBACKs
and writes nothing, so a wrong key is safe. After a successful live run, put the
NEW key into SSM (`/anot/prod/SETTINGS_ENCRYPTION_KEY`) and restart the
environment. To reverse a rotation, see **R3** in `ROLLBACK_V40_SSM.md`.

---

## Local development after v40

Nothing changes. Do **not** set `USE_SSM` (or set it to `false`). The app loads
`.env` exactly as before — no AWS credentials or network required.

```powershell
# local
Copy-Item .env.example .env   # if you don't have one
npm install
npm run dev
```

To rotate the local settings key, see `scripts/reencrypt-settings-key.js`:

```powershell
$env:OLD_SETTINGS_ENCRYPTION_KEY="current"; `
$env:NEW_SETTINGS_ENCRYPTION_KEY="new";     `
node scripts/reencrypt-settings-key.js --dry-run
```
