# CLEANUP_TASKS.md
## ANOT Health — Post-Audit Cleanup Backlog
## Generated: Thursday, July 2, 2026

This file tracks cleanup and remediation items from the Cursor security audit and code cleanup analysis. Full details in `audit-output/CURSOR_SECURITY_AUDIT_REPORT.md` and `audit-output/CURSOR_CODE_CLEANUP_REPORT.md`.

---

## P0 — Before Saturday Launch

### Security (Completed in Audit Session)
- [x] Remove `SKIP_MFA_FOR_DEMO` bypass code from `auth.js`, `authController.js`
- [x] Add startup throw if `SKIP_MFA_FOR_DEMO=true` still in environment
- [x] Add production startup requirement for `S3_AUDIO_BUCKET`
- [x] Verify backend tests pass (131/131)
- [x] Verify frontend build succeeds

### Security (Manual Verification Required)
- [ ] Confirm `SKIP_MFA_FOR_DEMO` is **absent** from production SSM Parameter Store and EB environment
- [ ] Confirm `S3_AUDIO_BUCKET` is **set** in production SSM
- [ ] Confirm BAAs signed with Deepgram, Anthropic, AWS (Friday)
- [ ] Remove or disable `POST /api/admin/reset-database` before production PHI
- [ ] Test 1-hour audio upload end-to-end (Thursday)
- [ ] Test database restore procedure (Friday)
- [ ] Test doctor MFA enrollment on physical device (Friday)

---

## P1 — This Week (Cleanup)

### Files to Delete
- [ ] `anot-frontend-main/anot-frontend-main/src/utils/sanitize.js`
- [ ] `anot-frontend-main/anot-frontend-main/src/components/PortalTooltip.jsx`
- [ ] `anot-frontend-main/anot-frontend-main/src/components/PortalTooltip.css` (if present)
- [ ] `anot-frontend-main/anot-frontend-main/src/components/ConfidenceBadge.jsx`
- [ ] `anot-frontend-main/anot-frontend-main/src/components/confidence.css`
- [ ] `anot-frontend-main/anot-frontend-main/src/utils/confidence.js`
- [ ] `anot-backend-main/anot-backend-main/src/utils/cloudWatchValidator.js`

### Code Edits
- [ ] Remove `ConfidenceBadge` re-export from `pages/shared.jsx:495`
- [ ] Remove unused `extractConfidence` import in `transcriptionService.js:1`
- [ ] Replace smoke-only `App.test.jsx` with meaningful test or remove file
- [ ] Gate `VITE_CSRF_DEBUG` on `import.meta.env.DEV` only (`api.js`, `csrf.js`)
- [ ] Remove production `visitId` logging in `Clinician/index.jsx:2227-2248`

### Dependencies to Review
- [ ] Evaluate `streamingAudioProcessor.js` — delete file + `bull` dep if unused
- [ ] Evaluate `scripts/inventory.js` + `mysql2` — remove if MySQL ops no longer needed

---

## P2 — Next Sprint (Refactor & Hardening)

### Large File Refactors
- [ ] Split `pages/Clinician/index.jsx` (3,634 lines) into modules
- [ ] Split `pages/Admin/index.jsx` (2,442 lines) into tab components
- [ ] Split `pages/Scribe/index.jsx` (1,583 lines) into sub-components
- [ ] Split `controllers/authController.js` (640 lines) by concern

### Security Hardening
- [ ] Remove hardcoded S3 bucket fallback in `s3Storage.js:20` (dev-only default)
- [ ] Move super-admin preserve email from `adminResetController.js:13` to SSM/env
- [ ] Clamp `BCRYPT_ROUNDS` minimum to 12 in `bcryptCost.js`
- [ ] Set DB pool `max: 20` in `db.js`
- [ ] Add webhook-specific rate limiting
- [ ] Scope QPS patient/visit/note queries to assigned records
- [ ] Add root-level `ErrorBoundary` in `App.jsx`
- [ ] Enable `AUDIT_CLOUDWATCH_ENABLED=true` in production
- [ ] Add Glacier transition to S3 audio lifecycle (if compliance requires)

### Dependency Updates
- [ ] Resolve npm audit moderate: `uuid` via `bull` and `exceljs`
- [ ] Resolve npm audit low: `esbuild` dev dependency (frontend)

### Duplicate Routes / Consolidation
- [ ] Review QPS-wide PHI access vs minimum-necessary policy
- [ ] Consolidate admin health vs public health endpoints (document intent)

---

## Audit Reports Location

| Report | Path |
|--------|------|
| Security Audit | `audit-output/CURSOR_SECURITY_AUDIT_REPORT.md` |
| Code Cleanup | `audit-output/CURSOR_CODE_CLEANUP_REPORT.md` |
| This task list | `CLEANUP_TASKS.md` |

---

## Notes

- Backend test count: **131** (was 132; one MFA bypass test removed with feature deletion)
- Frontend test count: **19** in 6 files (exceeds original target of 11)
- ESLint: 0 errors backend (17 warnings), 0 errors frontend
- Estimated quick cleanup savings: ~400–600 lines, 4–6 files
