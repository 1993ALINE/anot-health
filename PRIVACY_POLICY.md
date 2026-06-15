# Privacy Policy

**Anot Health**
**Effective Date:** June 16, 2026
**Version:** 1.0

This Privacy Policy explains what information the Anot Health platform ("Anot Health," "we," "us")
collects, how we store and protect it, how long we keep it, and the choices and rights you have. We
built Anot Health to handle Protected Health Information (PHI) responsibly and in line with HIPAA,
and we've written this policy in plain language so it's easy to follow.

This policy applies to the Anot Health web application and backend services. It is intended for the
healthcare organizations (our customers) and their workforce members — administrators, clinicians,
scribes, and quality reviewers — who use the platform.

---

## 1. Who This Policy Is For

Anot Health is a **business associate** to the healthcare providers who use it. Those providers are
the **covered entities** that own the patient relationship and the clinical record. We process PHI on
their behalf under a Business Associate Agreement (BAA). Patients with questions about their own
records should contact their healthcare provider directly; this policy describes how Anot Health, as
the technology platform, handles data.

---

## 2. What Data We Collect

We collect only what we need to provide clinical documentation services (the HIPAA "minimum
necessary" principle).

| Category | What it includes |
| --- | --- |
| **Patient encounter audio** | Voice recordings of clinical visits captured through the app |
| **Transcripts** | Text transcriptions produced from the audio |
| **AI-generated and finalized notes** | Draft clinical notes generated from transcripts, plus the clinician-finalized note |
| **Patient details tied to a visit** | Patient name, medical record number (MRN), visit type, and visit date |
| **User (workforce) account information** | Name, email address, role, specialty, phone, NPI/license (where provided) |
| **Operational metadata** | Audit logs (who did what and when), IP address, browser/user-agent, timestamps |
| **System configuration** | Integration settings and API keys (stored encrypted) |

We do **not** sell personal information, and we do not use PHI for advertising.

---

## 3. How We Use Data

We use the data above only to:

- Transcribe encounter audio and generate draft clinical notes.
- Let authorized users review, edit, finalize, and (where enabled) mark notes as uploaded to an EHR.
- Authenticate users, enforce role-based access, and keep accounts secure.
- Maintain a tamper-resistant audit trail for security and HIPAA compliance.
- Operate, troubleshoot, and improve the reliability of the service.

---

## 4. How We Store and Protect Data

Security is built into the platform:

- **Encryption at rest — audio:** Encounter audio is stored in Amazon S3 with **AES-256
  server-side encryption** in a private bucket. Audio is never served from a public URL — it is
  reachable only through an authenticated, authorized endpoint that issues short-lived, time-limited
  links.
- **Encryption at rest — database:** Patient details, notes, user accounts, and audit logs live in
  **Amazon RDS (PostgreSQL) encrypted at rest** on a network-restricted instance.
- **Encryption in transit:** All traffic between your browser, our servers, and our service partners
  travels over **TLS (HTTPS)**. HTTPS is enforced end to end.
- **Access control:** Access is **role-based** (super admin, admin, clinician, scribe, quality
  reviewer). Users can only reach the data and features their role permits.
- **Authentication hardening:** Strong password policy (12+ characters with mixed character types),
  forced password change on first login or after an admin reset, mandatory PHI awareness training
  before first access, session expiry, and rate limiting to slow brute-force attempts.
- **Tamper-resistant audit logs:** Every significant action is recorded in an **append-only** audit
  log that cannot be quietly edited or deleted.
- **Error monitoring with PHI scrubbing:** Our error-monitoring tooling is configured to strip
  request bodies, identifiers, and other free-text so PHI is not transmitted to it.

---

## 5. How Long We Keep Data (Retention)

| Data Type | Retention | What happens |
| --- | --- | --- |
| **Encounter audio** | **90 days**, then automatically deleted | Audio is removed from storage 90 days after capture, and immediately (best effort) when its visit is deleted |
| **Transcripts, notes, visit records** | Retained for the life of the clinical record | Kept per the healthcare provider's recordkeeping obligations; deletion is an authorized, audited action |
| **Audit logs** | **7 years (2,555 days)** | Append-only; the only sanctioned deletion is a role-restricted retention purge after the retention window |
| **Workforce accounts** | Duration of engagement | Deprovisioned (disabled/removed) when a user leaves; account deletion is audited |

The audit-log retention floor is enforced at a **6-year minimum** in the system so the HIPAA
requirement can't be accidentally misconfigured below it.

---

## 6. Third Parties (Sub-processors)

We rely on a small set of trusted partners to deliver the service. Each handles PHI only as needed
and under a signed Business Associate Agreement (BAA) or equivalent contractual safeguard:

| Partner | Role | Safeguard |
| --- | --- | --- |
| **Amazon Web Services (AWS)** | Infrastructure — database (RDS), audio storage (S3), hosting, CDN | AWS BAA covers the services in use |
| **Deepgram** | Speech-to-text transcription of encounter audio | BAA signed |
| **Anthropic** | AI generation of draft clinical notes from transcripts | BAA signed (zero data retention enabled) |

We review these relationships at least annually and whenever the data flow changes. We do not share
PHI with any other third party except as required by law or with the covered entity's authorization.

---

## 7. Your Rights and Choices

Because Anot Health acts on behalf of healthcare providers, requests related to a patient's records
are generally fulfilled **through the covered entity**. Subject to that relationship, the platform
supports:

- **Access:** Authorized users can view the records their role permits.
- **Export:** Notes and audit records can be exported by authorized users (e.g. CSV/XLSX/PDF for
  audit logs).
- **Correction:** Clinicians can edit and finalize notes; account details can be updated by the user
  or an administrator.
- **Deletion:** Visits and the associated audio can be deleted by authorized users; audio is also
  auto-deleted after 90 days. Workforce accounts can be disabled or removed by an administrator.

To make a request, workforce users should contact their administrator; covered entities and patients
should use the contact below or reach out to their provider.

---

## 8. Data Location

Anot Health's infrastructure is hosted on AWS in the **Asia Pacific (Singapore) region**
(`ap-southeast-1`). Some processing by sub-processors (Deepgram, Anthropic) may occur in other
regions under their respective agreements.

---

## 9. Breach Notification

If a breach affecting PHI occurs, we follow our documented incident response and breach notification
process, including notifying the affected covered entity without unreasonable delay and within the
timelines required by the HIPAA Breach Notification Rule. See `BREACH_RESPONSE_PLAN.md` and the
`SECURITY_AND_COMPLIANCE_MANUAL.md` for details.

---

## 10. Changes to This Policy

We may update this Privacy Policy as the platform or applicable regulations change. We will revise
the "Effective Date" and version above and, for material changes, notify customers through
appropriate channels.

---

## 11. Contact Us

Questions or requests about privacy:

- **Privacy / Compliance:** privacy@anot.health
- **Support:** support@anot.health
- **Administrator / Security Officer:** admin@anot.health

> **Note:** The governing-law and entity details for contractual purposes are set out in the Terms of
> Service and the applicable Business Associate Agreement.
