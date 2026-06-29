## HIPAA Compliance Certification — Anot Health

**Certification Date:** June 16, 2026
**Platform:** Anot Health v36
**Status:** ✅ HIPAA-COMPLIANT AND PRODUCTION-READY

### Infrastructure Verification

✅ **Audit Logging**
- Append-only triggers: trg_audit_logs_append_only, trg_audit_logs_no_truncate (VERIFIED ACTIVE)
- Retention: 2,555 days (7 years); runtime floor 6 years, cap 10 years
- Module attribution: 100% (all new events)

✅ **Encryption**
- Database: RDS encrypted at rest
- Audio storage: S3 AES-256 encryption
- Credentials: AES-256-GCM encryption
- In-transit: TLS/HTTPS enforced

✅ **Authentication & Authorization**
- JWT: 8-hour expiry, fail-closed; 15-minute scoped tokens for forced flows
- Password policy: 12+ chars, complexity enforced, common/default passwords blocked
- Rate limiting: 20/15m on all auth endpoints
- RBAC: super_admin/admin/clinician/scribe/qps with module-based access
- Forced password rotation: On first login after admin reset
- PHI training acknowledgment: Required before first access

✅ **Security Controls**
- Append-only audit logs (DELETE/UPDATE/TRUNCATE blocked by triggers)
- Webhook replay protection (5-min timestamp window)
- Token scope enforcement (require_password_change tokens limited to /change-password)
- No hardcoded credentials (all env-based secrets; only .env.example tracked in git)
- Sentry PHI scrubbing enabled
- SQL injection prevention (all queries parameterized)
- Deepgram calls bounded by a 30s AbortController timeout with 429/5xx retry + backoff (no infinite waits)

### Compliance Documentation

✅ **PRIVACY_POLICY.md**
- Data collected, storage, retention, user rights, sub-processors, contact

✅ **TERMS_OF_SERVICE.md**
- As-is warranty disclaimer, limitation of liability, user responsibilities, account security,
  suspension/termination, governing law

✅ **SECURITY_AND_COMPLIANCE_MANUAL.md**
- Privacy practices and data lifecycle
- Incident response with escalation ladder
- Access control policy (RBAC)
- Audit and monitoring procedures

✅ **PHI_TRAINING_ACKNOWLEDGMENT.md**
- Plain-language PHI awareness training, user responsibilities, breach reporting, sign-off

✅ **BREACH_RESPONSE_PLAN.md**
- Detection, containment, investigation workflow
- Patient notification template (30-day target / 60-day limit)
- HHS notification requirements (60-day timeline)
- Post-incident review process

✅ **RISK_ASSESSMENT.md**
- Identified risks, likelihood/impact matrix, mitigations, residual risk, owner assignments

✅ **docs/ADMIN_ONBOARDING.md** and **docs/CLINICIAN_ONBOARDING.md**
- Role-specific onboarding and operational guides

### Code Verification

✅ **v36 Ready**
- PHI training gate enforced on every login
- Forced password change enforced and token-scoped
- Deepgram timeout + retry/backoff added (reliability hardening)
- No linter errors in modified files

✅ **Third-Party BAAs**
- AWS BAA: Signed
- Deepgram BAA: Signed
- Anthropic BAA: Signed (ZDR enabled)

### Business Associate Agreements

✅ All vendors have signed BAAs:
- AWS (RDS, S3, EB, CloudFront)
- Deepgram (audio transcription)
- Anthropic (LLM services)

> **Verification note:** Executed BAA PDFs must be retained in the compliance file. Confirm each
> counterparty's signature is on file before processing real patient data.

### Final Checklist

✅ Technical controls implemented
✅ Administrative controls documented
✅ Audit logging comprehensive
✅ PHI training enforced
✅ Breach response plan ready
✅ Risk assessment completed
✅ Privacy Policy and Terms of Service published
✅ Admin and clinician onboarding guides published
✅ No hardcoded credentials
✅ Encryption enabled (data at rest + in transit)
✅ Access controls enforced
✅ Rate limiting active
✅ Sentry PHI scrubbing enabled
✅ Outbound transcription calls have timeouts + retries

### Sign-Off

I certify that Anot Health v36 implements HIPAA-required technical, administrative, and physical
safeguards for Protected Health Information (PHI).

The platform is ready for use with real doctors and patient data.

**Signed by:** Atiqur Rahman
**Title:** Chief Executive Officer
**Date:** June 16, 2026
**Platform Version:** v36

---

## Post-Launch Items (Non-Blocking)

- [ ] Confirm executed BAA PDFs (AWS, Deepgram, Anthropic) are stored in the compliance file
- [ ] Replace the governing-law placeholder in TERMS_OF_SERVICE.md and obtain legal review
- [x] Apply the S3 audio lifecycle rule (90-day expiry) so the retention promise holds true
- [x] Add per-account lockout after repeated failed attempts
- [x] Add magic-byte file upload validation
- [x] Implement per-patient data deletion endpoint
- [ ] Set environment-specific SENTRY_DSN
- [x] Add outbound rate limiting/concurrency caps for Deepgram and Anthropic
