# CURSOR_FIX_413_NGINX — Fix nginx 413 on Audio Uploads

Audio uploads fail with **413 Request Entity Too Large** from nginx on Elastic Beanstalk **before** the request reaches Node.js. nginx `client_max_body_size` is too small for long recordings.

## Upload limit configuration

Audio upload size is controlled by **`FFMPEG_MAX_UPLOAD_MB`** (environment / SSM), not the admin DB setting alone:

- **Env var:** `FFMPEG_MAX_UPLOAD_MB` (default **500**)
- **SSM:** `/anot/prod/FFMPEG_MAX_UPLOAD_MB` — sync via `node scripts/sync-rate-limit-config.js`
- **Resolution:** env → DB value → default 500 (`src/utils/ffmpegUploadLimits.js`)

## Step 1: EB Extension Configuration

Create `.ebextensions/01_nginx_bodysize.config`:

```yaml
files:
  /etc/nginx/conf.d/01_client_max_body_size.conf:
    mode: "000644"
    owner: root
    group: root
    content: |
      client_max_body_size 500m;
```

## Step 2: Express Body Parser Limits

**File:** `src/server.js`

Audio uploads use **multipart/form-data** (Multer), not `express.json`. Keep JSON limits at 2 MB (API) / 15 MB (webhooks) for security — they do not affect audio uploads.

Verify the existing 413 error handler remains in place for oversized JSON bodies.

## Step 3: Multer Upload Limits

**File:** `src/middleware/fileValidation.js`

```javascript
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
```

Also check `src/services/streamingAudioProcessor.js` (`MAX_FILE_SIZE_MB = 200`).

**Note:** Upload size is also capped by `ffmpeg_max_upload_mb` in system settings (Admin → AI). Ensure production value is ≥ 200 if testing 30-minute recordings.

## Step 4: Run Tests BEFORE Deployment

**CRITICAL: Test locally first to ensure no regressions**

```bash
# Backend (from anot-backend-main/anot-backend-main)
npm run test

# Frontend (from anot-frontend-main/anot-frontend-main)
npm run test
```

Verify:

- [ ] Jest backend tests: all passing (112/112)
- [ ] Vitest frontend tests: all passing (16/16)
- [ ] File validation tests pass with new 200MB limit
- [ ] No new errors introduced
- [ ] Coverage maintained

If any tests fail, fix them **before** deployment.

## Step 5: Deploy and Test

After tests pass:

1. Commit changes to git
2. Deploy to EB:
   ```bash
   npm run build
   powershell -File scripts/deploy-to-eb.ps1
   ```
3. Wait 5–10 minutes for EB to apply nginx config to all instances

## Step 6: Verify in Production

**Health check:**
```bash
curl https://app.anot.health/api/health
```

**End-to-end audio upload:**
1. Login as clinician
2. Create new encounter, record 5-minute audio, stop
3. Confirm upload progress, no 413, transcription completes
4. Repeat with 15-minute recording

**If 413 persists:**
1. `eb logs --all`
2. Verify `.ebextensions/01_nginx_bodysize.conf` deployed
3. SSH to instance and confirm `/etc/nginx/conf.d/01_client_max_body_size.conf`

## Pre-deploy Checklist

- [ ] `.ebextensions/01_nginx_bodysize.config` created
- [ ] `MAX_FILE_SIZE` = 200MB in `fileValidation.js`
- [ ] Backend tests pass
- [ ] Frontend tests pass
- [ ] Ready for deployment (user confirms "OK to deploy")

## Expected Outcome

- 5-minute (~27MB), 15-minute (~80MB), and 30-minute (~160MB) uploads succeed
- nginx passes requests to Node.js backend
- All tests still passing
