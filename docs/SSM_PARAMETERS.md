# SSM Parameter Store — Standard Paths

All production secrets and ops-tunable config live under a single prefix:

```
/anot/prod/{VARIABLE_NAME}
```

`VARIABLE_NAME` matches the `process.env` key exactly (UPPER_SNAKE_CASE). Never use
kebab-case (`jwt-secret`) or alternate prefixes (`/anot/` without `/prod`).

## Bootstrap

At boot, `src/config/loadSecrets.js` runs when `USE_SSM=true`:

1. Reads `SSM_PREFIX` (default `/anot/prod`)
2. Calls `GetParametersByPath` recursively with decryption
3. Maps `/anot/prod/JWT_SECRET` → `process.env.JWT_SECRET`

Set on Elastic Beanstalk:

| EB env var | Value |
|------------|-------|
| `USE_SSM` | `true` |
| `SSM_PREFIX` | `/anot/prod` |
| `SSM_REGION` | `ap-southeast-1` (or your region) |

## Required parameters

| SSM path | Env var | Type | Purpose |
|----------|---------|------|---------|
| `/anot/prod/JWT_SECRET` | `JWT_SECRET` | SecureString | Session signing (≥32 bytes) |
| `/anot/prod/SETTINGS_ENCRYPTION_KEY` | `SETTINGS_ENCRYPTION_KEY` | SecureString | AES-256-GCM for DB-stored API keys |
| `/anot/prod/DB_PASSWORD` | `DB_PASSWORD` | SecureString | PostgreSQL password |
| `/anot/prod/DB_HOST` | `DB_HOST` | String | RDS endpoint (optional if set in EB) |
| `/anot/prod/S3_AUDIO_BUCKET` | `S3_AUDIO_BUCKET` | String | S3 bucket for audio uploads |
| `/anot/prod/DEEPGRAM_API_KEY` | `DEEPGRAM_API_KEY` | SecureString | Deepgram Nova-3 Medical API key |

## Rate limits (ops-managed, not in DB)

Synced via `node scripts/sync-rate-limit-config.js`:

| SSM path | Default |
|----------|---------|
| `/anot/prod/RATE_LIMIT_LOGIN_MAX` | `5` |
| `/anot/prod/RATE_LIMIT_LOGIN_WINDOW_MINUTES` | `15` |
| `/anot/prod/RATE_LIMIT_API_MAX` | `100` |
| `/anot/prod/RATE_LIMIT_API_WINDOW_MINUTES` | `1` |
| `/anot/prod/FFMPEG_MAX_UPLOAD_MB` | `500` |

`FFMPEG_MAX_UPLOAD_MB` overrides the DB admin setting and caps audio upload size (nginx + Multer). Supports ~1-hour recordings at typical bitrates.

## NOT stored in SSM (by design)

| Secret | Storage | Why |
|--------|---------|-----|
| Deepgram API key | SSM (`DEEPGRAM_API_KEY`) or encrypted DB | Nova-3 Medical transcription |
| Anthropic API key | Encrypted DB | Admin self-service rotation via Settings UI |

See [ADMIN_SETTINGS_ARCHITECTURE.md](./ADMIN_SETTINGS_ARCHITECTURE.md).

## IAM

The EB instance profile needs:

- `ssm:GetParametersByPath`, `ssm:GetParameter` on `arn:aws:ssm:*:account:parameter/anot/prod/*`
- `kms:Decrypt` for SecureString parameters

Ops user policy (`fix-ssm-ops-permissions.ps1`) scopes read to `/anot/prod/*`.

## CLI examples

```bash
# Write a secret
aws ssm put-parameter \
  --name /anot/prod/JWT_SECRET \
  --type SecureString \
  --value "$(openssl rand -base64 48)" \
  --overwrite

# List all prod parameters (names only)
aws ssm get-parameters-by-path \
  --path /anot/prod \
  --recursive \
  --query 'Parameters[].Name'

# Sync rate limits
node scripts/sync-rate-limit-config.js
```

## Migration from legacy paths

Older setup scripts used kebab-case under `/anot/` (e.g. `/anot/jwt-secret`). Re-create
parameters under `/anot/prod/JWT_SECRET` and delete legacy entries after verifying boot.
