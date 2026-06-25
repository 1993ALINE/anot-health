# Admin Settings Architecture

How Anot stores configuration, secrets, and ops-tunable parameters.

## Two-tier secret model

```
┌─────────────────────────────────────────────────────────────┐
│  Elastic Beanstalk boot (USE_SSM=true)                      │
│  loadSecrets.js → /anot/prod/* → process.env              │
└──────────────────────────┬──────────────────────────────────┘
                           │
         SETTINGS_ENCRYPTION_KEY ──────────────┐
                           │                    │
                           ▼                    ▼
              ┌────────────────────┐   ┌─────────────────────┐
              │  system_settings   │   │  SSM rate limits    │
              │  (PostgreSQL)      │   │  RATE_LIMIT_*       │
              │  AES-256-GCM:      │   │  (ops rotation,     │
              │  • deepgram key    │   │   no app restart)   │
              │  • anthropic key   │   └─────────────────────┘
              └────────────────────┘
                           ▲
                           │ Admin → Settings UI
                           │ PUT /api/settings
```

### Why API keys live in the encrypted database

- **Admin self-service:** Super Admins rotate Deepgram/Anthropic keys from
  **Admin → Settings** without SSH, SSM console access, or redeploy.
- **Audit trail:** Key set/clear events are logged (never the value).
- **Encryption at rest:** Keys are stored as `deepgram_api_key_enc` /
  `anthropic_api_key_enc` blobs, encrypted with `SETTINGS_ENCRYPTION_KEY`
  (AES-256-GCM via `src/utils/settingsEncryption.js`).

### Why rate limits live in SSM

- **Ops-owned tuning:** Platform team adjusts throttling without DB migrations.
- **Multi-instance consistency:** All EB instances read the same values at boot.
- **Sync tool:** `node scripts/sync-rate-limit-config.js` upserts
  `/anot/prod/RATE_LIMIT_*` parameters.

## Backend startup flow

1. `loadSecrets()` — hydrate `process.env` from `/anot/prod/*`
2. `ensureUserProfileSchema()` — DB columns
3. `cleanCorruptedSettings()` — drop undecryptable key blobs
4. `loadAiSettings()` — read `system_settings`, decrypt API keys in memory
5. Serve requests; AI pipeline uses decrypted keys from runtime cache only

## Rotating API keys (admin procedure)

1. Sign in as Admin / Super Admin
2. Navigate to **Admin → Settings → AI & transcription**
3. Enter the new key in the password field (Deepgram or Anthropic)
4. Click **Save settings**
5. Keys are encrypted immediately; `invalidateAiSettingsCache()` refreshes runtime config

To **remove** a key: check “Remove stored API key on save” and save.

## Rotating SETTINGS_ENCRYPTION_KEY

This is an ops task (not self-service):

1. Generate a new key → `/anot/prod/SETTINGS_ENCRYPTION_KEY`
2. Run `npm run reencrypt:settings-key` (re-encrypts all DB blobs)
3. Restart EB environment

See `DEPLOYMENT_V40_SSM.md` for the full rotation runbook.

## Security notes

- API keys never appear in GET responses (`*_api_key_set: true` flag only)
- Plaintext keys exist only in the HTTPS request body during save
- `SETTINGS_ENCRYPTION_KEY` must be set in production; dev uses a ephemeral fallback
