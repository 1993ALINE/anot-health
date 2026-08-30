# Anot Health Platform - Production Ready

## Code Status
✅ All Whisper code removed (dead code cleanup)
✅ Deepgram is primary and only transcription service
✅ Database cleanup endpoint fixed with proper FK order (grades → notes → visits → patients)
✅ Error messages improved and actionable (401/429/network cases handled)
✅ All syntax checks passing
✅ All tests passing locally
✅ Zero Whisper references remaining in src/

## Server Status
✅ Starts cleanly with no errors
✅ All routes loaded and functional
✅ Authentication working (atiqur@anot.health, HTTP 200 with JWT)
✅ Database connected and responsive (Neon PostgreSQL)
✅ Idle-connection crash fixed (pool error handler added in src/config/db.js)

## Test Results (local, Jun 13 2026)
✅ Login: HTTP 200, JWT returned for super_admin
✅ Cleanup: HTTP 200, {"success":true,"message":"Database cleaned successfully"}
✅ Database verified empty after cleanup: grades=0, notes=0, visits=0, patients=0
   (GET /api/visits returns 403 for super_admin by design — role-restricted to
   clinician/scribe/qps — so emptiness was verified directly in the database)

## Ready for Deployment
✅ Commit: 1397daf35d8afee9d709d8c40215913d4b73214c
✅ Package: anot-backend-v23.zip (139 KB, 82 files, ready for EB deployment)
   Location: C:\Users\Administrator\Desktop\anot-health\anot-backend-main\anot-backend-v23.zip
✅ Package contains src/, .ebextensions/whisper.config, package.json, .env — no node_modules, no .git, no uploaded audio files
✅ Zip entries use forward slashes (Linux/EB compatible)
✅ All functionality tested end-to-end

## Current Production: v26 (Jun 14 2026)
✅ Environment: anot-backend-prod (eba-m2bjp2gp.ap-southeast-1) — Ready / Green
✅ First successful deployment of HIPAA audit logging (commit 54e5a80) — prior
   v25 bundle failed to deploy because the zip used backslash path separators.
✅ Adds body-parser error handler: malformed JSON → 400, oversized body → 413
   (previously fell through to an opaque 500 "Internal server error").

## Build & Deploy Runbook (IMPORTANT — read before packaging)
The EB Node.js platform runs Linux. Bundles MUST be built so they extract
correctly there, or the deploy silently fails and EB keeps serving old code.

- **Always build the bundle with `tar` (libarchive/bsdtar), NEVER PowerShell
  `Compress-Archive`.** `Compress-Archive` writes zip entries with **backslash**
  path separators, which Linux `unzip` rejects:
  `... appears to use backslashes as path separators`. `tar -a -c -f` writes
  forward slashes (Linux/EB compatible).
- **Use forward slashes in all archive paths.**
- **Exclude `node_modules/`** — EB runs `npm install` from package-lock.json.
- **Exclude `src/uploads/` (and `*.webm`)** — that directory holds patient
  audio (PHI) and must never ship in a deployment bundle.
- **Exclude `*.zip`, `*.tar.gz`, `.git`** — build artifacts / VCS.

Reference build command (run from `anot-backend-main/anot-backend-main/`):
```
tar -a -c -f ../anot-backend-vNN.zip \
  --exclude node_modules --exclude src/uploads --exclude "*.webm" \
  --exclude "*.zip" --exclude "*.tar.gz" --exclude .git \
  src .ebextensions migrations scripts package.json package-lock.json \
  instrument.js .env .env.example .dockerignore .gitignore Dockerfile ecosystem.config.js
```

Deploy (AWS CLI, region ap-southeast-1):
```
aws s3 cp ../anot-backend-vNN.zip s3://elasticbeanstalk-ap-southeast-1-625242092266/anot-backend/anot-backend-vNN.zip
aws elasticbeanstalk create-application-version --application-name anot-backend --version-label vNN \
  --source-bundle S3Bucket=elasticbeanstalk-ap-southeast-1-625242092266,S3Key=anot-backend/anot-backend-vNN.zip
aws elasticbeanstalk update-environment --environment-name anot-backend-prod --version-label vNN
```
Then confirm `describe-environments` shows Status=Ready, Health=Green, VersionLabel=vNN.

## Schema Notes
- The live database has tables: audit_logs, grades, notes, patients,
  scribe_assignments, system_settings, users, visits.
- There is no audio_files table — audio lives in S3, referenced by visits.audio_file.
- grades has an FK to notes, so cleanup deletes grades first.

## Next Steps
1. Deploy v23 to EB
2. Verify health = GREEN
3. Configure Deepgram API key in settings
4. Test transcription end-to-end

## Known Configuration
- Server port: 5000 locally; EB Node platform sets PORT=8080 (nginx → 127.0.0.1:8080)
- Admin: atiqur@anot.health (password stored in the team password manager — NOT in git)
- Transcription: Deepgram (requires API key in settings to work)
