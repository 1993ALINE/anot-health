# Anot Health — Security Risk Assessment

**Document Owner:** Anot Health
**Classification:** Internal — Confidential
**Version:** 1.0
**Effective Date:** June 14, 2026
**Regulatory Basis:** HIPAA Security Rule — Risk Analysis (45 CFR §164.308(a)(1)(ii)(A))
**Review Cadence:** Annual, or upon material change to infrastructure, vendors, or threat landscape

---

## 1. Purpose & Methodology

This document records Anot Health's analysis of risks to the confidentiality, integrity, and
availability of electronic Protected Health Information (ePHI). For each risk we assess the
**likelihood** of occurrence and the **impact** if it occurs, document **current mitigations**
(as implemented and verified in production), and state the **residual risk** remaining after those
controls.

### Rating Scales

**Likelihood**

| Rating | Meaning |
| --- | --- |
| Low | Unlikely given current controls; would require multiple control failures |
| Medium | Plausible; occurs in comparable environments |
| High | Expected to occur without further action |

**Impact**

| Rating | Meaning |
| --- | --- |
| Low | Minimal effect; no PHI exposure |
| Medium | Limited PHI/operational impact; contained |
| High | Significant PHI exposure or service disruption |
| Critical | Large-scale PHI exposure; major regulatory/legal/reputational harm |

---

## 2. Risk Matrix

| # | Risk | Likelihood | Impact | Residual Risk | Owner |
| --- | --- | --- | --- | --- | --- |
| R1 | Unauthorized database access | Low | Critical | **Low** | Anot Health |
| R2 | Compromised credentials | Medium | High | **Low–Medium** | Anot Health |
| R3 | Third-party (sub-processor) breach | Low | High | **Low–Medium** | Anot Health |
| R4 | S3 misconfiguration | Low | Critical | **Low** | Anot Health |
| R5 | Insider threat | Low | Critical | **Low–Medium** | Anot Health |

---

## 3. Detailed Risk Register

### R1 — Unauthorized Database Access

| Attribute | Detail |
| --- | --- |
| **Description** | An external attacker or unauthorized party gains direct access to the PostgreSQL/RDS database containing PHI, clinical notes, user accounts, and audit logs. |
| **Likelihood** | **Low** |
| **Impact** | **Critical** |
| **Current Mitigations** | • RDS / managed PostgreSQL **encrypted at rest**. • Network-restricted database access. • TLS in transit. • **Append-only audit logs** enforced by DB triggers — even with DB access, audit records cannot be silently altered (UPDATE) or deleted (DELETE/TRUNCATE) outside the sanctioned, role-restricted retention purge. • Audit trail captures access for forensic reconstruction. • Credential rotation procedures in the breach plan. |
| **Residual Risk** | **Low** — Encryption and network restrictions make access difficult; tamper-resistant audit logs limit undetected damage. |
| **Planned Improvements** | Run the application under a least-privilege DB role (INSERT/SELECT) separate from the migration/owner role (addresses owner ability to drop triggers). |
| **Owner** | Anot Health |

---

### R2 — Compromised Credentials

| Attribute | Detail |
| --- | --- |
| **Description** | A user's account credentials (clinician, scribe, admin, or super_admin) are phished, reused, or brute-forced, allowing an attacker to authenticate and access PHI. |
| **Likelihood** | **Medium** — credential attacks are the most common vector industry-wide. |
| **Impact** | **High** |
| **Current Mitigations** | • **Rate limiting: 20 attempts per 15 minutes on all authentication endpoints** to slow brute-force. • All authentication events audited (`LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGOUT`, `PASSWORD_RESET`, `SELF_PASSWORD_CHANGED`). • Failed-login monitoring (7-day / 24-hour counts) via audit summary. • **Role-based access control** limits blast radius to the compromised role's scope. • Session/token revocation and forced password reset in the breach plan. • Non-spoofable IP capture (`req.ip`) aids detection of anomalous source IPs. |
| **Residual Risk** | **Low–Medium** — Strong detection and containment; residual exposure remains until/if multi-factor authentication is universally enforced. |
| **Planned Improvements** | Enforce MFA for admin/super_admin roles; add automated alerting on failed-login spikes and impossible-travel logins. |
| **Owner** | Anot Health |

---

### R3 — Third-Party (Sub-processor) Breach

| Attribute | Detail |
| --- | --- |
| **Description** | A breach at a sub-processor that handles PHI (Deepgram for transcription, Anthropic for note generation, AWS for hosting) exposes data in transit or at rest with that vendor. |
| **Likelihood** | **Low** |
| **Impact** | **High** |
| **Current Mitigations** | • **Signed Business Associate Agreements (BAAs)** with Deepgram and Anthropic; AWS BAA covers RDS/S3. • Data shared on a **minimum-necessary** basis. • Encrypted transport to all sub-processors. • Third-party-notice path in the breach plan for vendor-reported incidents. • Annual review of sub-processor relationships and data flows. |
| **Residual Risk** | **Low–Medium** — Contractual and technical safeguards in place, but data residing with vendors is partly outside Anot's direct control. |
| **Planned Improvements** | Periodic review of vendor security posture (SOC 2 / HIPAA attestations); maintain an up-to-date data-flow inventory. |
| **Owner** | Anot Health |

---

### R4 — S3 Misconfiguration

| Attribute | Detail |
| --- | --- |
| **Description** | The S3 bucket storing encounter audio is misconfigured (e.g., made public, overly permissive policy, or leaked access keys), exposing PHI audio. |
| **Likelihood** | **Low** |
| **Impact** | **Critical** |
| **Current Mitigations** | • Audio stored with **AES-256 server-side encryption**. • Bucket is **private**; audio is **never** served from a public URL. • Access only via authenticated endpoint `GET /api/audio/:visitId`, which issues **short-lived presigned URLs**. • **90-day** audio retention reduces the exposure window of stored data. • Credentials sourced from the AWS provider chain (instance profile) rather than hard-coded. • Key rotation / URL invalidation procedures in the breach plan. |
| **Residual Risk** | **Low** — Encryption plus private-bucket + presigned-URL access pattern means a single misconfiguration is unlikely to expose readable PHI. |
| **Planned Improvements** | Enable S3 Block Public Access at the account level, automated config drift detection, and S3 Object Lock (WORM) for archived audit data. |
| **Owner** | Anot Health |

---

### R5 — Insider Threat

| Attribute | Detail |
| --- | --- |
| **Description** | An authorized workforce member (clinician, scribe, admin, or super_admin) intentionally or negligently misuses their access — viewing PHI without need, exfiltrating data, or tampering with records. |
| **Likelihood** | **Low** |
| **Impact** | **Critical** |
| **Current Mitigations** | • **Comprehensive, append-only audit trail** — every PHI read (`VISITS_VIEWED`, `VISIT_HISTORY_VIEWED`), create, update, and delete is attributed to a user and **cannot be erased** to hide misuse. • **Role-based least-privilege** access; sensitive operations (retention purge) restricted to `super_admin`. • Module-level permissions on the admin portal. • **PHI awareness training** with signed acknowledgment. • Account deprovisioning on termination (audited via `USER_DELETED`). • Minimum-necessary access policy. |
| **Residual Risk** | **Low–Medium** — Detection and accountability are strong; deterrence and after-the-fact attribution are high, though a determined authorized insider can still access data within their legitimate scope. |
| **Planned Improvements** | Periodic access reviews/recertification; anomaly detection on unusual PHI-access volume per user; separation of duties for DB owner vs. application role. |
| **Owner** | Anot Health |

---

## 4. Summary & Risk Acceptance

All five identified risks are assessed at **Low** or **Low–Medium** residual risk after current
controls. The combination of encryption at rest and in transit, role-based access control,
tamper-resistant append-only audit logging with 7-year retention, rate-limited authentication,
signed BAAs, and PHI scrubbing in monitoring provides defense-in-depth aligned with the HIPAA
Security Rule.

Planned improvements (least-privilege DB role, MFA for privileged accounts, account-level S3 public
access block, anomaly alerting, and periodic access recertification) are tracked to further reduce
residual risk and are reviewed at each assessment cycle.

| Field | Value |
| --- | --- |
| Assessment owner | Anot Health |
| Approver | Security Officer / Administrator (admin@anot.health) |
| Contacts | support@anot.health · admin@anot.health |
| Next scheduled review | June 14, 2027 (or upon material change) |

**Revision History**

| Version | Date | Author | Summary |
| --- | --- | --- | --- |
| 1.0 | 2026-06-14 | Anot Health | Initial risk assessment reflecting verified production controls |
