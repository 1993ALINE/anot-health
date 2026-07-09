# CURSOR SECURITY & CODE QUALITY AUDIT REPORT
## Generated: Thursday, July 2, 2026

**Scope:** Full ANOT Health monorepo — backend (`anot-backend-main`), frontend (`anot-frontend-main`), deploy/infrastructure (`deploy/`, `scripts/`)

**Reference audit document:** `COMPREHENSIVE_BUG_ISSUE_AUDIT.md` was not present in the workspace; audit performed against the checklist in the Cursor instructions.

**Post-audit fixes applied in this session:**
- Removed all `SKIP_MFA_FOR_DEMO` MFA bypass code paths
- Added startup failure if `SKIP_MFA_FOR_DEMO=true` is still set in environment
- Added production startup requirement for `S3_AUDIO_BUCKET` (prevents silent use of hardcoded bucket fallback)

---

## ✅ PASSED CHECKS (What's secure)

### Authentication & Session Management
- **bcrypt cost 12** — Default via `getBcryptRounds()` in `src/utils/bcryptCost.js:3-9`; used for hash/compare in `authController.js`, `userController.js`, `seed-dev-users.js`
- **JWT expiration 1h** — `JWT_EXPIRES_IN || '1h'` in `authController.js:44`, `mfa.js:27`
- **Session cookie aligned with JWT** — HttpOnly, SameSite=strict, Secure in prod (`sessionCookie.js:15-31`)
- **15-minute client idle timeout** — `useSessionTimeout.jsx` (13 min warning, 15 min logout + PHI purge)
- **Account lockout** — 5 failed attempts / 15 min window / 30 min lock (`accountLockout.js`)
- **Token version revocation** — Logout and password change increment `token_version`
- **MFA for PHI roles** — clinician, scribe, qps, admin, super_admin (`mfaService.js`)
- **PHI training gate** — Versioned acknowledgment required before full session
- **Forced password change gate** — Temp token scoped to `/change-password`
- **JWT secret validation** — ≥32 chars required at startup (`startupDiagnostics.js`)
- **`MFA_BYPASS` blocked in production** — Throws on boot

### Authorization & Access Control
- **Global `protect` on clinical routes** — patients, notes, visits, assignments, audio
- **`restrict('role')` on admin/clinical routes** — All major route modules
- **Super Admin-only admin routes** — `admin.js`, health diagnostics, retention purge
- **Super Admin cannot be created via API** — `authController.js:449-451`
- **Visit isolation for clinician/scribe** — `visitAccess.js`, `getVisitForUser`
- **Patient delete admin-only** — `patients.js`
- **`enforceAdminMfa` on `/api/admin`** — `server.js:262-266`

### Data Protection & Encryption
- **SSM secret bootstrap** — `loadSecrets.js`, `USE_SSM=true` in production EB config
- **No hardcoded JWT/API keys in runtime code** — Secrets from env/SSM
- **PHI redaction in logs/audit/Sentry** — `phiSafeLogger.js`, `auditLogger.js`, `instrument.js`
- **S3 SSE-AES256 on upload** — `s3Storage.js`
- **Dedicated webhook secret** — No JWT reuse (`webhookSignature.js`)
- **Temp audio files cleaned** — S3 download unlink in `finally` blocks
- **Settings encryption key required in prod** — `SETTINGS_ENCRYPTION_KEY` ≥32 chars

### Input Validation & Injection Prevention
- **Parameterized SQL (dominant pattern)** — All controllers use `$1`, `$2` placeholders
- **No `eval()` or `Function()`** — Zero matches in backend `src/`
- **FFmpeg via `spawn` with arg arrays** — No shell injection (`audioProcessingService.js`)
- **Audio path regex validation** — `audio.js`, `aiPipelineHelpers.js`
- **Multer MIME allow-list + magic bytes** — `fileValidation.js`
- **Password policy** — Length, complexity, blocklist (`passwordPolicy.js`)

### XSS Prevention (Frontend)
- **No `dangerouslySetInnerHTML`, `innerHTML`, or `eval()`** — Zero matches in frontend `src/`
- **React default escaping** — Clinical text in `<pre>` / `<textarea>`, not raw HTML
- **Production error sanitization** — `api.js:195-199` strips server details in prod builds

### CSRF Protection
- **All POST/PUT/PATCH/DELETE require CSRF** — Global middleware on `/api` (`server.js:246`, `csrf.js`)
- **GET/OPTIONS skip CSRF** — Safe methods exempt
- **Webhook routes bypass CSRF with HMAC** — `deepgramWebhookController.js` + `webhookSignature.js`
- **Frontend double-submit** — `csrf.js` + `api.js` attach `X-CSRF-Token` on all mutations

### Rate Limiting
- **Login 5/15 min** — `rateLimit.js:24-36`, `auth.js:20`
- **API 100/min (prod)** — `rateLimit.js:37-40`, `server.js:206`
- **MFA verify 10/15 min** — `rateLimit.js:81-93`
- **Password change 20/15 min** — `auth.js:11-17`
- **Redis-backed when `REDIS_URL` set** — `rateLimit.js:109-147`
- **Global middleware applied** — Before route handlers in `server.js`

### Security Headers
- **X-Frame-Options: DENY** — `server.js:148`
- **X-Content-Type-Options: nosniff** — `server.js:147`
- **Strict-Transport-Security** — Helmet + explicit 1-year HSTS (`server.js:138-142,149-150`)
- **Content-Security-Policy** — Helmet CSP configured (`server.js:117-134`)
- **CORS allow-list** — No wildcard `*.vercel.app` regex

### HIPAA Controls
- **Recording consent required before upload** — `audio.js:33-39`, `consent.js:40-86`
- **Consent attestation logged** — Audit with IP/timestamp
- **Server-enforced consent** — Cannot upload without `patient_consent_recorded`
- **Audit logs 6–10 year retention** — `auditRetentionPolicy.js:5-12` (2190–3650 days)
- **Append-only audit logs** — DB triggers documented in migrations
- **Comprehensive PHI access logging** — Controllers call `auditLog` on read/write/delete
- **Breach response documented** — `BREACH_RESPONSE_PLAN.md`, `SECURITY_AND_COMPLIANCE_MANUAL.md`
- **BAAs documented** — Deepgram, Anthropic, AWS listed as signed in compliance manual

### Code Quality
- **Backend tests: 131 passing** (26 suites) — Target was 132+; 1 test removed with MFA bypass deletion
- **Frontend tests: 19 passing** (6 files) — Exceeds documented target of 11
- **Backend ESLint: 0 errors** (17 warnings)
- **Frontend ESLint: 0 errors**
- **No `console.log` in frontend `src/`**
- **HttpOnly session cookies** — JWT not in JS-accessible storage

### Infrastructure
- **SSM for secrets in production** — `USE_SSM=true`, `strip-eb-secrets.sh`
- **EB health check `/api/health`** — Early health server in `server.js:32-48`
- **CloudWatch alarms script** — 5+ alarms in `scripts/setup-alarms.sh`
- **S3 block public access** — Documented in `deploy/aws/setup.sh`
- **S3 audio 90-day lifecycle** — `deploy/aws/s3-audio-lifecycle.json`
- **RDS TLS support** — `db.js` with bundled RDS CA bundle

---

## ⚠️ FINDINGS (What needs attention)

### 🚨 CRITICAL (Priority 1 — Blocking Saturday)

| # | Finding | Location | Status | Recommended Fix |
|---|---------|----------|--------|-----------------|
| C1 | **`SKIP_MFA_FOR_DEMO` MFA bypass** | Was in `auth.js`, `authController.js`, `startupDiagnostics.js`, `.env.example`, tests | **FIXED** — Bypass code removed; startup throws if env still set | Verify SSM/EB does not have `SKIP_MFA_FOR_DEMO=true` |
| C2 | **Hardcoded S3 bucket fallback with AWS account ID** | `s3Storage.js:20` — `'anot-audio-625242092266'` | **PARTIALLY FIXED** — Prod startup now requires `S3_AUDIO_BUCKET` | Remove hardcoded fallback entirely in a follow-up PR |
| C3 | **`POST /api/admin/reset-database` purges all PHI** | `admin.js:18`, `adminResetController.js:49-72` | **OPEN** | Remove route or gate behind `NODE_ENV !== 'production'` |
| C4 | **Hardcoded super-admin preserve email in reset controller** | `adminResetController.js:13` — `atiqurrahmanaline@gmail.com` | **OPEN** | Move to env/SSM or remove reset endpoint |
| C5 | **BAA operational verification** | Documented in `SECURITY_AND_COMPLIANCE_MANUAL.md` | **VERIFY FRIDAY** | Confirm signed BAAs on file with Deepgram, Anthropic, AWS |

### HIGH (Priority 2)

| # | Finding | Location | Recommended Fix |
|---|---------|----------|-----------------|
| H1 | **QPS role has organization-wide PHI access** | `patientController.js:57-58`, `visitController.js:151-152`, `noteController.js:126-165` | Scope QPS queries to assigned/reviewed records |
| H2 | **Temporary gate tokens in JSON body (XSS-stealable)** | `authController.js:49-60,131,148,380-391` | Move to HttpOnly cookies where feasible |
| H3 | **Webhooks exempt from API rate limit** | `rateLimit.js:44-48` | Add webhook-specific rate limiting |
| H4 | **Hardcoded test password in script** | `scripts/test-audio-upload.js:120` — `DevClinician!2026` | Require env var only, no default |
| H5 | **Production console logging with visitId on upload failure** | `Clinician/index.jsx:2227-2248` | Remove or gate behind DEV |
| H6 | **`VITE_CSRF_DEBUG` can log tokens in prod builds** | `api.js:130-133`, `csrf.js:11-18` | Gate on `import.meta.env.DEV` only |
| H7 | **1-hour audio timeout not tested** | `aiTranscriptionService.js:166-177` | Manual test Thursday per launch checklist |
| H8 | **Database restore not tested** | Ops procedure | Test Friday per launch checklist |
| H9 | **Doctor MFA not tested on device** | Ops procedure | Test Friday per launch checklist |

### MEDIUM (Priority 3)

| # | Finding | Location | Recommended Fix |
|---|---------|----------|-----------------|
| M1 | **bcrypt cost not clamped to minimum 12** | `bcryptCost.js:4-9` | Add floor: `Math.max(12, n)` |
| M2 | **DB connection pool max not set to 20** | `db.js:105-122` — Uses pg default (10) | Set `max: 20` explicitly |
| M3 | **S3 lifecycle is 90-day expiration, not Glacier transition** | `s3-audio-lifecycle.json` | Add Glacier transition if compliance requires cold storage |
| M4 | **CloudWatch audit shipping off by default** | `logger.js:7-8` — Requires `AUDIT_CLOUDWATCH_ENABLED=true` | Enable in production SSM |
| M5 | **Consent is clinician attestation, not patient-direct** | `consent.js:39-57` | Document as intentional; consider patient signature flow in P2 |
| M6 | **No root-level React ErrorBoundary** | `App.jsx` | Wrap `<Routes>` in `ErrorBoundary` |
| M7 | **npm audit: moderate uuid via bull/exceljs** | Backend `package.json` | Upgrade transitive deps next sprint |
| M8 | **Backend console.log in production paths** | 22 files with console.log/debug | Migrate to structured logger; ensure no PHI |
| M9 | **Auth cache 10s TTL post-deactivation** | `auth.js:10-11,26-28` | Acceptable; document or reduce for sensitive ops |

### LOW

| # | Finding | Location |
|---|---------|----------|
| L1 | Duplicate HSTS headers (Helmet + manual) | `server.js:138-142,149-150` |
| L2 | `mysql2` dependency only used in `scripts/inventory.js` | `package.json:48` |
| L3 | Unused `streamingAudioProcessor.js`, `cloudWatchValidator.js` | See cleanup report |
| L4 | Frontend `App.test.jsx` is smoke-only (`expect(true).toBe(true)`) | `src/__tests__/App.test.jsx:4-6` |
| L5 | Doc drift: env example says JWT ≥16 chars; code requires ≥32 | `env.production.example:28` vs `startupDiagnostics.js:35` |

---

## 🚨 CRITICAL ISSUES SUMMARY

### SKIP_MFA_FOR_DEMO locations
**Before fix:** `auth.js:42-49`, `authController.js:96-116,369-376`, `startupDiagnostics.js:311,384-386`, `.env.example:116`, `auth.gates.test.js:27-38`

**After fix:** Only defensive startup guard remains at `startupDiagnostics.js:383-384` (throws if env still set)

### Hardcoded secrets
| Item | File | Line |
|------|------|------|
| S3 bucket + account ID fallback | `s3Storage.js` | 20 |
| Super-admin preserve email | `adminResetController.js` | 13 |
| Dev test password default | `scripts/test-audio-upload.js` | 120 |
| Dev webhook secret placeholder | `webhookSignature.js` | 17 (non-prod only) |

### Unprotected PHI endpoints
**None found** — All PHI routes require `protect` middleware. Intentionally public routes:
- `GET /api/health` — ALB probe (no PHI)
- `GET /api/settings/public` — Branding only (`mapPublicRow`)
- `POST /api/auth/login`, MFA/PHI training gates — Rate-limited, no PHI returned

### Missing auth
**None on PHI endpoints.** Webhook uses HMAC instead of JWT (correct).

---

## 📊 STATISTICS

| Metric | Value |
|--------|------:|
| Backend source files scanned | 86 |
| Frontend source files scanned | 69 |
| Backend lines of code | ~11,106 |
| Frontend lines of code | ~30,346 |
| **Total issues found** | **32** |
| Critical issues | 5 (2 fixed, 3 open/verify) |
| High priority | 9 |
| Medium priority | 9 |
| Low priority | 5 |
| Backend tests passing | 131 / 131 |
| Frontend tests passing | 19 / 19 |
| Backend ESLint errors | 0 |
| Frontend ESLint errors | 0 |

---

## ✅ READY FOR SATURDAY?

### **Conditional YES** — with pre-launch verification

**Why YES:**
- Core security controls are in place: MFA enforcement (bypass removed), CSRF, rate limits, Helmet headers, parameterized SQL, audit logging, consent gates, session timeout
- All 131 backend + 19 frontend tests pass
- Frontend production build succeeds
- Compliance documentation exists (breach plan, BAAs documented)

**Blockers to clear before launch:**

1. **Verify `SKIP_MFA_FOR_DEMO` is NOT set in production SSM/EB** — Server will now refuse to boot if present
2. **Verify `S3_AUDIO_BUCKET` IS set in production SSM** — New startup requirement
3. **Remove or disable `POST /api/admin/reset-database`** in production deployment
4. **Confirm BAAs signed** with Deepgram, Anthropic, AWS (Friday task)
5. **Run operational tests:** 1-hour audio upload, DB restore, doctor MFA on device (Thu/Fri tasks)

**If items 1–3 fail at deploy time, launch should be delayed.**

---

*Report generated by Cursor automated audit. Critical MFA bypass fix applied in same session.*
