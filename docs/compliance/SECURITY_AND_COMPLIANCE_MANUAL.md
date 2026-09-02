# Anot Health — Security & Compliance Manual

**Document Owner:** Anot Health
**Classification:** Internal — Confidential
**Version:** 1.0
**Effective Date:** June 14, 2026
**Next Review:** June 14, 2027 (annual, or upon material change)
**Regulatory Scope:** HIPAA Privacy Rule (45 CFR Part 164, Subpart E), HIPAA Security Rule (45 CFR Part 164, Subpart C), HIPAA Breach Notification Rule (45 CFR §§164.400–414)

---

## 1. Executive Summary

Anot Health operates a clinical documentation platform that captures, transcribes, and stores
patient encounter audio and AI-generated clinical notes. Because this data constitutes Protected
Health Information (PHI), Anot Health maintains administrative, physical, and technical safeguards
designed to satisfy the HIPAA Security Rule (45 CFR §164.302–318) and Privacy Rule.

This manual documents the security program as **implemented and verified in production**, not as
aspiration. Key control highlights:

| Control Area | Implementation | Status |
| --- | --- | --- |
| Encryption at rest (database) | Amazon RDS / managed PostgreSQL with storage-level encryption | Active |
| Encryption at rest (audio) | Amazon S3 with AES-256 server-side encryption | Active |
| Encryption in transit | TLS 1.2+ for all client/server and service-to-service traffic | Active |
| Audit logging | Append-only `audit_logs` table enforced by database triggers | Verified active |
| Audit retention | 7 years (2,555 days), HIPAA §164.316(b)(2) floor of 6 years exceeded | Active |
| Audio retention | 90 days, then automated deletion | Active |
| Access control | Role-based (admin / super_admin / clinician / scribe) | Active |
| Brute-force protection | Rate limiting on authentication endpoints | Active |
| Business Associate Agreements | Signed with Deepgram and Anthropic | Executed |
| Error monitoring | Sentry with PHI scrubbing enabled | Active |

The remainder of this manual details privacy practices, the end-to-end data lifecycle, incident
response, access control, and audit/monitoring procedures.

---

## 2. Privacy Practices

### 2.1 Data Types We Process

| Category | Examples | Sensitivity |
| --- | --- | --- |
| **PHI — Audio** | Recorded patient encounter audio | High |
| **PHI — Clinical text** | Transcriptions, AI draft notes, finalized clinical notes | High |
| **PHI — Demographic** | Patient identifiers associated with a visit | High |
| **Workforce identity** | User accounts, names, email addresses, roles | Moderate |
| **Operational metadata** | Audit logs, IP addresses, user-agent strings, timestamps | Moderate |
| **System configuration** | Encrypted API keys and integration settings | High |

Anot Health collects only the minimum data necessary to deliver clinical documentation services,
consistent with the HIPAA **Minimum Necessary** standard (§164.502(b)).

### 2.2 Retention Schedule

| Data Type | Retention Period | Enforcement |
| --- | --- | --- |
| Encounter audio (S3) | **90 days**, then deleted | Lifecycle / application deletion |
| Audit logs | **7 years (2,555 days)** | Append-only table + sanctioned retention purge |
| Clinical notes / visit records | Retained for the life of the clinical record per provider obligation | Application-managed |
| Workforce accounts | Duration of employment/engagement + deprovisioning on termination | Administrative |

The audit retention floor is clamped to **2,190 days (6 years)** minimum and **3,650 days (10 years)**
maximum at runtime, guaranteeing the HIPAA §164.316(b)(2) six-year minimum is never violated by
misconfiguration.

### 2.3 Deletion Practices

- **Audio:** Deleted from S3 90 days after capture, and immediately (best-effort) when an associated
  visit is deleted.
- **Audit logs:** Cannot be edited or arbitrarily deleted. The **only** sanctioned deletion path is
  the retention purge, which removes records strictly older than the configured retention window and
  is restricted to the Super Admin role. The purge itself is recorded as an audit event
  (`AUDIT_RETENTION_APPLIED`).
- **Visit / clinical records:** Deletion is an authorized, audited action (`VISIT_DELETED`) and
  cascades to associated audio cleanup.

---

## 3. Data Handling Procedures (Collection → Storage → Access → Deletion)

### 3.1 Collection

1. A clinician/scribe records encounter audio through the Anot application over a TLS-encrypted
   connection.
2. The act of creating a visit is captured as an audit event (`VISIT_CREATED`).
3. Only data necessary for transcription and note generation is collected (Minimum Necessary).

### 3.2 Processing & Sub-processors

1. Audio is sent to **Deepgram** for transcription under a signed **Business Associate Agreement (BAA)**.
2. Transcripts are processed by **Anthropic** to generate draft clinical notes, also under a signed **BAA**.
3. Service-to-service communication occurs over encrypted channels. Third-party API credentials are
   stored encrypted in system settings.

### 3.3 Storage

| Asset | Location | Protection |
| --- | --- | --- |
| Audio files | Amazon S3 (`anot-audio-*` bucket) | **AES-256 server-side encryption**; private bucket; access only via short-lived presigned URLs |
| Database (PHI, notes, users, audit) | Amazon RDS / managed PostgreSQL | **Encryption at rest**; network-restricted |
| Audit trail | `audit_logs` table | **Append-only**, trigger-enforced; tamper-resistant |

Audio is **never** served from a public URL. It is accessible only through the authenticated,
authorized endpoint `GET /api/audio/:visitId`, which issues time-limited presigned S3 URLs.

### 3.4 Access

- All API access requires authentication (`protect` middleware) and passes role restriction checks
  (`restrict(...)`) plus, for the admin portal, module-level permission checks
  (`requireAdminPortalModules(...)`).
- Every PHI read (e.g. viewing visits or visit history) is captured as an audit event
  (`VISITS_VIEWED`, `VISIT_HISTORY_VIEWED`).
- IP addresses in the audit trail are captured from the trusted `req.ip` (honoring
  `trust proxy = 1`), **not** from spoofable `X-Forwarded-For` headers.

### 3.5 Deletion

- Audio: time-based (90 days) and event-based (visit deletion) removal from S3.
- Audit logs: only via the sanctioned, role-restricted, audited retention purge after 7 years.
- Workforce: accounts are deprovisioned on termination; deletion is audited (`USER_DELETED`).

---

## 4. Incident Response Plan

> For the full operational playbook, see `BREACH_RESPONSE_PLAN.md`. This section defines roles and
> the escalation ladder.

### 4.1 Objectives

Detect, contain, eradicate, and recover from security incidents; notify affected parties and
regulators within legally required timelines; and improve controls post-incident.

### 4.2 Severity Classification

| Severity | Definition | Example |
| --- | --- | --- |
| **SEV-1 (Critical)** | Confirmed or likely PHI exposure | Unauthorized DB/S3 access, leaked credentials with data access |
| **SEV-2 (High)** | Security control failure without confirmed exposure | Failed audit-write spikes, repeated auth abuse |
| **SEV-3 (Moderate)** | Suspicious activity, no confirmed impact | Anomalous login patterns |
| **SEV-4 (Low)** | Policy deviation, no security impact | Misrouted internal report |

### 4.3 Escalation Ladder

1. **Discovery** → Anyone who detects an incident reports immediately to **support@anot.health**.
2. **Triage (within 1 hour)** → Security/On-call lead classifies severity.
3. **Escalation (SEV-1/SEV-2)** → Notify the **Security Officer / Administrator at admin@anot.health**.
4. **Containment** → Authorized administrators isolate affected systems and revoke credentials.
5. **Notification decision** → Security Officer determines breach status and notification obligations.
6. **Closure** → Post-incident review filed; corrective actions tracked to completion.

### 4.4 Mandatory Timelines

- **Patient notification:** without unreasonable delay and **no later than 60 days** after discovery
  (Anot targets initiation within **30 days**).
- **HHS notification:** within 60 days for breaches affecting **500+ individuals**; annual log for
  smaller breaches.

---

## 5. Access Control Policy

Anot Health enforces **role-based access control (RBAC)** with least-privilege defaults. PHI access
is restricted to authenticated users whose role and module permissions authorize the specific action.

### 5.1 Role Definitions

| Role | Purpose | Typical Permissions |
| --- | --- | --- |
| **super_admin** | Highest privilege; platform governance | Full administrative access; **sole** authority to apply audit retention purges; manage all users and settings |
| **admin** | Day-to-day administration | Manage users, view audit logs/exports, configure non-destructive settings, access admin portal modules |
| **clinician** | Licensed provider | Create/conduct visits, record audio, view and finalize their clinical notes |
| **scribe** | Documentation support | Assist with notes for assigned visits within granted scope |

### 5.2 Enforcement Mechanics

- **Authentication:** `protect` middleware validates the session/token on every protected route.
- **Authorization:** `restrict('admin','super_admin', ...)` gates role-sensitive routes; the audit
  API additionally requires the `audit` portal module permission.
- **Sensitive operations:** Retention purge is hard-restricted to `super_admin` (returns 403 otherwise).
- **Account lifecycle:** Creation (`USER_REGISTERED`), modification (`USER_UPDATED`), and removal
  (`USER_DELETED`) are all audited.

### 5.3 Authentication Hardening

- **Rate limiting on authentication endpoints** to slow brute-force attempts:
  - **20 attempts per 15 minutes on all authentication endpoints (`/api/auth/*`).**
  - This includes login, password reset, and all credential-related requests.
- General API rate limiting is also applied platform-wide.
- All authentication events are audited: `LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGOUT`,
  `SELF_PASSWORD_CHANGED`, `PASSWORD_RESET`.

---

## 6. Audit & Monitoring Procedures

### 6.1 Audit Logging (Technical Safeguard — §164.312(b))

Anot Health maintains a comprehensive, tamper-resistant audit trail in the `audit_logs` table.

**Events captured include:**

| Category | Events |
| --- | --- |
| Authentication | `LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGOUT`, `SELF_PASSWORD_CHANGED`, `PASSWORD_RESET` |
| Create | `VISIT_CREATED`, `USER_REGISTERED`, `SCRIBE_ASSIGNED` |
| Read (PHI) | `VISITS_VIEWED`, `VISIT_HISTORY_VIEWED`, `ADMIN_PORTAL_ACCESS` |
| Update | `VISIT_UPDATED`, `VISIT_STATUS_UPDATED`, `VISIT_ENDED`, `NOTE_CONTENT_UPDATED`, `NOTE_SUBMITTED`, `USER_UPDATED`, `lock_note` |
| Delete | `VISIT_DELETED`, `USER_DELETED`, `SCRIBE_UNASSIGNED` |
| Admin | `AUDIT_RETENTION_APPLIED` |

**Each record captures:** user ID, user name, user role, action, entity type/ID, IP address,
user-agent, status, module key, action category, structured event metadata (JSONB), request path,
and a non-null `created_at` timestamp.

### 6.2 Tamper Resistance (Append-Only)

The application connects to PostgreSQL as the table **owner**, which in PostgreSQL bypasses
`GRANT`/`REVOKE`. Append-only is therefore enforced with **database triggers**, which fire for every
role including the owner:

- `trg_audit_logs_append_only` — **UPDATE always rejected**; **DELETE rejected** unless the current
  transaction sets `anot.allow_audit_purge = 'on'`.
- `trg_audit_logs_no_truncate` — **TRUNCATE rejected** at the statement level.

This behavior is **verified on production**: arbitrary `UPDATE`/`DELETE`/`TRUNCATE` against
`audit_logs` are rejected; only the sanctioned retention purge (which sets the GUC) may remove rows
past the retention window.

### 6.3 Retention

- Audit retention: **2,555 days (7 years)**, exceeding the §164.316(b)(2) six-year minimum.
- Runtime clamp: floor **2,190 days**, cap **3,650 days**.

### 6.4 Monitoring & Alerting

- **Error & exception monitoring:** Sentry, with **PHI scrubbing enabled** so clinical content and
  identifiers are not transmitted to the monitoring service.
- **Audit-write reliability:** Failures to write audit records are reported to console and Sentry
  (`reportAuditFailure`) and are never silently dropped. Critical state changes audit inside the same
  database transaction as the change.
- **Operational logging:** Error responses are shipped to centralized logging (e.g. CloudWatch) for
  review.
- **Reviewable indicators:** failed-login counts (7-day / 24-hour), critical-status events (30-day),
  and per-user/module activity are queryable through the audit summary endpoints.

### 6.5 Audit Access & Export

- The `/api/audit` API is protected by authentication, role restriction (`admin`, `super_admin`),
  and the `audit` module permission.
- Exports (CSV/XLSX/PDF) are **CSV-injection-safe**.

---

## 7. Business Associate Management

| Sub-processor | Function | Safeguard |
| --- | --- | --- |
| **Deepgram** | Speech-to-text transcription | **BAA signed** |
| **Anthropic** | AI clinical note generation | **BAA signed** |
| **Amazon Web Services** | Infrastructure (RDS, S3) | AWS BAA applies to covered services |

Sub-processor relationships are reviewed at least annually and upon any change in data flow.

---

## 8. Document Control & Review

| Field | Value |
| --- | --- |
| Owner | Anot Health |
| Approver | Security Officer / Administrator (admin@anot.health) |
| Review cadence | Annual, or upon material infrastructure/regulatory change |
| Contacts | support@anot.health · admin@anot.health |

**Revision History**

| Version | Date | Author | Summary |
| --- | --- | --- | --- |
| 1.0 | 2026-06-14 | Anot Health | Initial audit-ready release reflecting verified production controls |
