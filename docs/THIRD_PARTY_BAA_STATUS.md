# Third-Party BAA Status

Last updated: 2026-06-25

This document tracks Business Associate Agreement (BAA) coverage for third-party services that may process Protected Health Information (PHI) on behalf of Anot Health.

## Summary

| Vendor | Service | BAA Status | PHI Processed | Retention |
|--------|---------|------------|---------------|-----------|
| Deepgram | Speech-to-text transcription | Required — execute BAA before production PHI | Audio recordings, transcripts | Per Deepgram contract; audio deleted after transcription when using callback mode |
| Anthropic | Clinical note draft generation | Required — execute BAA before production PHI | De-identified or minimum-necessary transcript excerpts | Not stored by Anthropic beyond API request lifecycle (verify current DPA) |
| AWS | Hosting (EB, RDS, S3, CloudWatch) | AWS BAA in place (standard for HIPAA workloads) | All application PHI at rest and in transit | RDS backups + S3 lifecycle; audit logs 6+ years |

## Deepgram

**Purpose:** Converts clinician audio recordings to text for scribe workflows.

**Data flow:**
1. Clinician uploads audio via `POST /api/audio/:visitId` (authenticated, encrypted in transit TLS 1.2+).
2. Audio stored in private S3 bucket (`AUDIO_BUCKET`); never public URLs.
3. Backend sends audio to Deepgram API (`api.deepgram.com`) with org API key (encrypted at rest in `system_settings`).
4. Transcript returned via sync response or webhook callback (`POST /api/webhooks/deepgram`).
5. Transcript stored in PostgreSQL `visits` / `notes` tables.

**Controls:**
- API key encrypted with `SETTINGS_ENCRYPTION_KEY` (AES-256-GCM).
- Webhook HMAC verification (`DEEPGRAM_WEBHOOK_SECRET`).
- Configurable HTTP timeout (`deepgram_timeout_ms`, admin UI 5–300 seconds).
- Auto-transcribe optional (`deepgram_auto_transcribe_on_upload`).

**Retention:** Audio remains in S3 until visit lifecycle policies apply. Transcripts subject to audit retention (minimum 2190 days / 6 years).

**Action:** Confirm signed BAA with Deepgram and document effective date in compliance records.

## Anthropic (Claude)

**Purpose:** Generates structured clinical note drafts from transcripts.

**Data flow:**
1. Backend loads transcript from database after Deepgram processing.
2. `aiPipeline.js` sends minimum-necessary prompt to Anthropic API (`api.anthropic.com`).
3. Draft note returned and stored in application database for clinician review/edit.
4. Clinician must approve final note — AI output is never auto-committed as legal record.

**Controls:**
- API key from env (`ANTHROPIC_API_KEY`) or encrypted DB setting.
- No OpenAI integration (removed Phase 2).
- Production errors scrubbed via Sentry `beforeSend` (see `instrument.js`).

**Retention:** Drafts and final notes follow application audit and visit retention policies.

**Action:** Confirm Anthropic BAA / HIPAA-eligible usage terms for production.

## AWS Infrastructure

**Services:** Elastic Beanstalk, RDS PostgreSQL, S3, CloudWatch Logs, SSM Parameter Store.

**Data flow:** All PHI resides in RDS and S3 within `ap-southeast-1` (account 625242092266). Secrets loaded from SSM at boot (`USE_SSM=true`).

**Retention:**
- Audit logs: minimum **2190 days** (6 years) in PostgreSQL; CloudWatch copy ~6 years (`retentionInDays: 2192`).
- RDS automated backups per production policy.

## Internal Policies

- Audit log append-only with super-admin-only retention purge (`auditController.applyRetention`).
- PHI redaction in logs via `phiSafeLogger.js` before CloudWatch/console output.
- Rate limiting: Redis-backed in production when `REDIS_URL` set; memory fallback for local dev.

## Compliance Checklist

- [ ] Deepgram BAA signed and filed
- [ ] Anthropic BAA / enterprise HIPAA terms confirmed
- [ ] AWS BAA active on production account
- [ ] Annual vendor review scheduled
- [ ] Subprocessor list updated in privacy policy
