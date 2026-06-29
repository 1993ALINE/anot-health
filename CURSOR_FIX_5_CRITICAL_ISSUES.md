# CURSOR_FIX_5_CRITICAL_ISSUES — Execution Guide

Critical HIPAA/security fixes for ANOT HEALTH v1.0.0 production launch.

## Fix 1: S3 audio deletion on patient delete

**File:** `anot-backend-main/anot-backend-main/src/controllers/patientController.js`

- Collect `audio_file` paths from visits before DB delete
- After transaction commit, delete each S3 object via `deleteAudio(dbPathToKey(...))`
- Audit each deletion as `PHI_AUDIO_DELETED` + CloudWatch `logDataAccess`
- **Test:** `src/__tests__/patientDelete.test.js`

## Fix 2: IndexedDB PHI cleanup on logout

**Files:**
- `anot-frontend-main/.../src/utils/offlineAudioQueue.js` — `destroyOfflinePhiDatabase()`
- `anot-frontend-main/.../src/utils/offlineUploadQueue.js` — `clearPendingUploads()`
- `anot-frontend-main/.../src/utils/sessionAuth.js` — `purgeClientPhiStorage()`, `performSecureLogout()`
- `anot-frontend-main/.../src/services/api.js` — `authAPI.logout()` purges PHI + hard reload
- `anot-frontend-main/.../src/components/LogoutButton.jsx` — secure sign-out component
- `anot-frontend-main/.../src/utils/useSessionTimeout.jsx` — idle timeout uses same purge

## Fix 3: Remove secrets from EB environment

**Files:**
- `deploy/aws/setup.sh` — EB env has `USE_SSM`, `SSM_PREFIX`, non-secret config only
- `deploy/aws/strip-eb-secrets.sh` — strips secrets from **existing** EB environments
- Secrets remain in SSM: `JWT_SECRET`, `DB_PASSWORD`, `SETTINGS_ENCRYPTION_KEY`, API keys

**Verify:**
```bash
aws elasticbeanstalk describe-configuration-settings \
  --application-name anot-backend --environment-name anot-backend-prod \
  --query 'ConfigurationSettings[0].OptionSettings[?Namespace==`aws:elasticbeanstalk:application:environment`]'
```
Confirm no `JWT_SECRET` or `DB_PASSWORD` values in output.

## Fix 4: Audit logging on bulk PHI reads

**File:** `anot-backend-main/.../src/controllers/noteController.js`

- `logPhiBulkRead()` emits `PHI_BULK_READ` + CloudWatch on:
  - `getMyNotes`, `getAllNotes`, `getClinicianNotes`, `getMyGrades`
- **Test:** `src/__tests__/noteBulkAudit.test.js`

## Fix 5: Production HA setup

**Files:**
- `deploy/aws/setup.sh` — `LoadBalanced` EB, MinSize=2, MaxSize=4, Multi-AZ RDS, `DB_SSL=true`
- `deploy/aws/harden-infrastructure.sh` — Multi-AZ, strip EB secrets, run alarms
- `scripts/setup-alarms.sh` — CloudWatch alarms (EB health, 5xx, latency, RDS)

**Deploy order:**
1. Apply code changes (backend + frontend)
2. `./deploy/aws/strip-eb-secrets.sh` (existing prod)
3. Redeploy backend via EB
4. `./deploy/aws/harden-infrastructure.sh`
5. Verify alarms in CloudWatch console

## Verification checklist

- [ ] Patient delete removes S3 audio (check audit log for `PHI_AUDIO_DELETED`)
- [ ] Logout clears IndexedDB (`AnotHealthDB` absent in DevTools → Application)
- [ ] EB console shows no secret env vars
- [ ] Note list API produces `PHI_BULK_READ` audit rows
- [ ] EB environment type = LoadBalanced, ≥2 instances
- [ ] RDS Multi-AZ = Yes
- [ ] CloudWatch alarms in OK/INSUFFICIENT_DATA (not ALARM)
