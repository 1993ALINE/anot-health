# Anot Health — Breach Response Plan

**Document Owner:** Anot Health
**Classification:** Internal — Confidential
**Version:** 1.0
**Effective Date:** June 14, 2026
**Regulatory Basis:** HIPAA Breach Notification Rule (45 CFR §§164.400–414)

**Key Contacts**

| Role | Contact |
| --- | --- |
| First report / triage | **support@anot.health** |
| Security Officer / escalation | **admin@anot.health** |

> This is an **actionable playbook**. When an incident is suspected, start at Phase 1 and work down.
> Do not wait for certainty — contain first, confirm later.

---

## Phase 0 — Detection

Know the signs. A breach may be surfacing if you see any of the following.

| Signal | Where it shows up | Example |
| --- | --- | --- |
| **Suspicious audit logs** | `/api/audit`, audit summary | Spike in `LOGIN_FAILED`; PHI reads (`VISITS_VIEWED`) from an unexpected user/IP; `VISIT_DELETED` or `USER_DELETED` you can't account for |
| **Authentication anomalies** | Audit trail, rate-limit hits | Logins from unfamiliar IPs/regions; repeated lockouts; off-hours admin access |
| **User reports** | support@anot.health | "I got logged out," "I see another patient's note," lost/stolen device, phished credentials |
| **System/monitoring alerts** | Sentry, CloudWatch | Audit-write failure alerts (`reportAuditFailure`), unexpected error spikes, S3/RDS access anomalies |
| **Third-party notice** | Email from vendor | Deepgram/Anthropic/AWS reporting a security event |

**Action on any signal:** open an incident record (timestamp, reporter, what was observed) and proceed to Phase 1.

---

## Phase 1 — Immediate Response (first hours)

**Goal: stop the bleeding and preserve evidence.**

1. **Acknowledge & assign.** First responder logs the incident and notifies **support@anot.health**.
   For any suspected PHI exposure, escalate to **admin@anot.health** immediately (target: within 1 hour).
2. **Classify severity** (see manual: SEV-1 confirmed/likely PHI exposure → SEV-4 low).
3. **Stop the breach:**
   - **Compromised credentials** → reset the affected password(s), force re-authentication, revoke
     active sessions/tokens.
   - **Unauthorized access path** → disable the offending account; tighten/restrict the affected
     route or role.
   - **Exposed S3/audio** → make the object/bucket private, rotate any leaked access keys, invalidate
     outstanding presigned URLs by rotating credentials.
   - **Database exposure** → rotate DB credentials, restrict network access, revoke the offending role.
4. **Isolate systems** without destroying evidence. Prefer disabling accounts and restricting access
   over deleting resources.
5. **Preserve evidence — do NOT delete logs.** The `audit_logs` table is append-only by design; keep
   it that way. Snapshot relevant logs (audit export, Sentry events, CloudWatch, S3/RDS access logs).
   Note exact timestamps.
6. **Document everything** in the incident record as you go.

> **Do not** attempt the retention purge, schema changes, or any cleanup that could remove evidence
> during an active investigation.

---

## Phase 2 — Investigation

**Goal: determine what happened, what data, and how many people.**

1. **Review the audit trail.** Using `/api/audit` (filter by user, action, IP, date range), reconstruct:
   - Who accessed what, from which IP, and when.
   - Which `VISITS_VIEWED` / `VISIT_HISTORY_VIEWED` / export events are tied to the suspect actor.
   - Any create/update/delete events during the window.
2. **Correlate** audit data with Sentry, CloudWatch, and AWS (S3/RDS) access logs.
3. **Determine scope:**
   - Which patients' PHI was involved (audio, transcripts, notes, identifiers)?
   - **How many individuals** are affected? (This drives notification obligations.)
   - Was data only *viewed*, or *exfiltrated/altered*?
4. **Assess if it is a reportable breach.** A breach of unsecured PHI is presumed reportable unless a
   risk assessment shows a **low probability of compromise**, considering: (a) nature/extent of PHI,
   (b) who accessed it, (c) whether it was actually acquired/viewed, (d) extent to which risk was
   mitigated. Document the determination.
5. **Confirm the count: is it 500+ individuals?** This changes HHS and media timelines (Phase 4).

---

## Phase 3 — Patient Notification

**Timeline: without unreasonable delay, and no later than 60 days after discovery. Anot Health
targets initiating notification within 30 days.**

Notify affected individuals in **plain language**, by first-class mail (or email if the individual
agreed to electronic notice).

**Required content (per §164.404(c)):** a brief description of what happened; the types of PHI
involved; steps individuals should take to protect themselves; what Anot Health is doing to
investigate, mitigate, and prevent recurrence; and contact information.

### Template Notification Letter

```
[Date]

Dear [Patient Name],

We are writing to inform you of a data security incident that may have involved your protected
health information. We take the privacy and security of your information seriously, and we want to
explain what happened and what we are doing about it.

WHAT HAPPENED
On [date of discovery], Anot Health identified [brief, non-technical description of the incident].

WHAT INFORMATION WAS INVOLVED
The information that may have been involved includes: [e.g., your name, encounter audio,
transcription, and/or clinical notes]. [State clearly if financial/SSN data was NOT involved.]

WHAT WE ARE DOING
Upon discovery, we immediately [contained the incident / reset credentials / restricted access /
launched an investigation]. We have reviewed our audit logs to determine the scope and have taken
steps to prevent a recurrence, including [specific safeguards strengthened].

WHAT YOU CAN DO
[e.g., Remain alert for suspicious activity; we recommend you monitor any related accounts.]
You do not need to take any action to keep using Anot Health services.

FOR MORE INFORMATION
If you have questions, please contact us at support@anot.health or admin@anot.health.

We sincerely apologize for any concern this may cause.

Sincerely,
Anot Health
```

---

## Phase 4 — HHS (and Media) Notification

| Affected individuals | HHS notification | Media notification |
| --- | --- | --- |
| **Fewer than 500** | Log the breach; report to HHS **annually**, within 60 days of the end of the calendar year | Not required |
| **500 or more** | Notify HHS **without unreasonable delay, no later than 60 days** after discovery, via the HHS Breach Portal | Notify prominent media outlets serving the affected region/state, without unreasonable delay (≤60 days) |

**HHS submission checklist (500+):**

- [ ] Breach Portal report filed at the HHS Office for Civil Rights (OCR) site.
- [ ] Date of breach and date of discovery recorded.
- [ ] Type of breach and PHI involved described.
- [ ] Number of individuals affected.
- [ ] Safeguards in place before the breach and actions taken after.
- [ ] Copy of report and confirmation retained in the compliance file.

> Regardless of size, **all** breaches are entered into the internal breach log and retained for at
> least 6 years.

---

## Phase 5 — Post-Incident Review

Within **2 weeks** of containment, the Security Officer leads a review.

1. **Root cause analysis.** What was the underlying cause (not just the symptom)? Use the audit
   evidence and timeline.
2. **Control gap assessment.** Which control failed or was missing? Map to `RISK_ASSESSMENT.md`.
3. **Corrective actions.** Define specific, owned, dated remediations (e.g., least-privilege DB role,
   tighter rate limits, additional alerting, training refresh).
4. **Update documentation.** Revise this plan, the Security & Compliance Manual, and the Risk
   Assessment as needed.
5. **Verify & close.** Confirm each corrective action is implemented and effective before closing the
   incident.

**Post-incident record (file with the incident):**

| Field | Entry |
| --- | --- |
| Incident ID / date | |
| Severity | |
| Individuals affected | |
| Root cause | |
| Notifications sent (patients / HHS / media) | |
| Corrective actions & owners | |
| Closure date | |

---

## Quick-Reference Flow

```
Detect ──► Report (support@anot.health)
              │  escalate SEV-1/2 ──► admin@anot.health
              ▼
        Contain (reset creds, isolate, PRESERVE logs)
              ▼
        Investigate (audit logs → scope → # affected)
              ▼
   Reportable breach?  ──No──► Document low-probability determination, log it
              │Yes
              ▼
   Notify patients (≤60 days; target 30) ──► Notify HHS (annual <500 / ≤60 days 500+ ) ──► Media if 500+
              ▼
        Post-incident review (root cause + fixes)
```
