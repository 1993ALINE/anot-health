# v42 Deployment — One-Time Corrupted Settings Cleanup

## What changed

On first boot after deploy, the app runs `cleanCorruptedSettings()` which:
- Detects `deepgram_api_key_enc` / `anthropic_api_key_enc` that cannot decrypt with the current key
- Sets those columns to `NULL` (other settings untouched)
- Writes flag file `/var/app/current/.settings-cleaned` so it never runs again on that instance
- Continues startup normally

## Deploy

```powershell
cd anot-backend-main\anot-backend-main
powershell -File scripts\build-v42-artifact.ps1
```

Upload `artifacts/anot-backend-v42.zip` to Elastic Beanstalk as **v42** and deploy.

## After deploy

1. Confirm health: `GET https://api.anot.health/` → `"version":"v42"`
2. Check logs for `[cleanCorruptedSettings] Cleared corrupted encrypted settings: ...`
3. Re-enter Deepgram / Anthropic API keys in **Admin → Settings**

## Re-run cleanup manually

Delete the flag file and restart the app:

```bash
rm /var/app/current/.settings-cleaned
# restart EB instance or `eb restart`
```

Or set `SETTINGS_CLEANUP_FLAG_PATH` to a custom path.
