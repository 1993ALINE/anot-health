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

| Phase | What | Approx wait | Reversible? |
| --- | --- | --- | --- |
| 1 | Pre-flight checks (identity, EB, RDS, health) | ~1 min | n/a (read-only) |
| 2 | Backups: export EB config + RDS snapshot | **5–10 min** (snapshot) | n/a |
| 3 | Generate new `SETTINGS_ENCRYPTION_KEY` | ~10 s | n/a (in memory) |
| 4 | Put all secrets into SSM SecureStrings | ~2 min | delete params |
| 5 | IAM: grant EB instance role `ssm:GetParametersByPath` + `kms:Decrypt` | ~1 min | remove policy |
| 6 | Re-encrypt `system_settings` (dry-run → live) | ~1 min | restore snapshot |
| 7 | Build v40 artifact (`npm install`, zip) | ~2–3 min | n/a |
| 8 | Enable `USE_SSM=true` on EB env | ~2–3 min | set `false` |
| 9 | Deploy v40 app version | ~3–5 min | redeploy v39 |
| 10 | Verify (health, login, settings decrypt, AI note) | ~2 min | n/a |
| 11 | Remove plaintext secrets from EB env props | ~2–3 min | re-add from backup |

**Total: ~30–40 minutes**, most of it the RDS snapshot in Phase 2.

### Ordering rationale (why this sequence is safe)

1. **Backup before any change** (Phase 2) — RDS snapshot is the data rollback.
2. **SSM + IAM before deploy** (Phases 4–5) — so when `USE_SSM` flips on, the
   params and permissions already exist.
3. **Re-encrypt before deploy** (Phase 6) — the NEW key goes to SSM in Phase 4;
   v39 still runs with the OLD key from EB env. We rotate the DB blobs to the
   NEW key while the app is untouched. The dry-run proves the OLD key is correct
   before any write.
4. **Enable SSM, then deploy** (Phases 8–9) — v40 reads the NEW key from SSM and
   can decrypt the freshly re-encrypted blobs.
5. **Remove plaintext last** (Phase 11) — only after the app is verified healthy
   on SSM, so a failure at any earlier point still has the EB env fallback.

---

## Testing checklist (verify each phase)

- **Phase 1** — `aws sts get-caller-identity` shows account `625242092266`; EB
  env health is `Green`; RDS status `available`; health URL returns JSON.
- **Phase 2** — `backup-v39-*/eb-config-settings-v39.json` exists and is
  non-empty; `aws rds describe-db-snapshots --db-snapshot-identifier <id>` shows
  `available`.
- **Phase 4** — `aws ssm get-parameters-by-path --path /anot/prod --recursive
  --query 'Parameters[].Name'` lists every expected secret name.
- **Phase 5** — `aws iam get-role-policy --role-name aws-elasticbeanstalk-ec2-role
  --policy-name anot-ssm-read-prod` returns the policy.
- **Phase 6** — dry-run prints `would have re-encrypted N/N blob(s)`; live run
  prints `✅ Done. Committed N`. (If the OLD key is wrong it aborts with
  `decryption with OLD key failed` and writes nothing.)
- **Phase 7** — `dist/anot-backend-v40.zip` exists; `package.json` shows
  `@aws-sdk/client-ssm` and `1.40.0`.
- **Phase 8** — `describe-configuration-settings` shows `USE_SSM=true`.
- **Phase 9** — environment `VersionLabel` is `v40`, health `Green`.
- **Phase 10** — health endpoint returns `"version":"v40"`; **EB logs contain
  `[loadSecrets] ✅ Loaded N parameter(s) from SSM`**; you can log in; Admin →
  Settings shows the saved Deepgram/Anthropic keys (proves re-encryption + new
  key match); generating an AI note works.
- **Phase 11** — after env props removed and the env restarts, health still
  returns `v40` and login still works (proves the app is fully SSM-sourced).

### Quick log check

```powershell
aws elasticbeanstalk request-environment-info --environment-name $EbEnvName --info-type tail
Start-Sleep 20
aws elasticbeanstalk retrieve-environment-info --environment-name $EbEnvName --info-type tail
# look for: [loadSecrets] ✅ Loaded N parameter(s) from SSM
```

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
