# v41 Deployment — Graceful Settings Decryption

## What changed

The backend no longer crashes when encrypted `system_settings` values (Deepgram / Anthropic API keys) cannot be decrypted — for example when `SETTINGS_ENCRYPTION_KEY` was rotated without re-encrypting stored ciphertext.

**Behaviour after v41:**
- Decryption failures are logged once per field and skipped
- The app boots and serves all non-AI API routes normally
- Deepgram / Anthropic features are disabled until keys are re-entered in Admin → Settings (or `ANTHROPIC_API_KEY` env var is set)

## Deploy

```powershell
cd anot-backend-main\anot-backend-main
pwsh -File scripts\build-v41-artifact.ps1
```

Upload `artifacts/anot-backend-v41.zip` to Elastic Beanstalk as application version **v41**, then deploy.

## Fix encrypted keys (post-deploy)

1. Confirm `SETTINGS_ENCRYPTION_KEY` in SSM/EB matches the key that was used when keys were saved, **or**
2. Re-enter Deepgram and Anthropic API keys in **Admin → Settings** (re-encrypts with the current key), **or**
3. Run `npm run reencrypt:settings-key` if rotating the encryption key intentionally (see `DEPLOYMENT_V40_SSM.md`)

## Verify

```bash
curl https://api.anot.health/
# {"message":"Anot API is running","version":"v41","status":"healthy"}
```

Logs should show:
```
[Startup] AI settings loaded (decryption failures are non-fatal)
[settingsEncryption] Skipping corrupted setting — app will continue without this value
```
