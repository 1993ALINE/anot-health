# PHI Awareness Training & Acknowledgment

**Anot Health** · Version 1.0 · Effective June 14, 2026

This is a short, plain-language training you complete before working with patient information on
Anot Health. Please read it, then sign at the bottom.

---

## What is PHI?

**PHI** stands for **Protected Health Information**. It's any information that can identify a patient
*and* relates to their health, care, or treatment.

On Anot Health, PHI includes:

- Recorded **patient encounter audio**
- **Transcripts** and **AI-generated clinical notes**
- **Patient names** and details tied to a visit

If it could tell someone *who* a patient is and *something about their health*, treat it as PHI.

---

## How Anot Health Protects PHI

You're working on a platform built with patient privacy in mind:

- **Encryption** — Audio is stored with AES-256 encryption in Amazon S3, and the database is
  encrypted at rest. Everything travels over secure (TLS) connections.
- **Audit logging** — The system records who did what and when. These logs are **append-only**
  (they can't be quietly edited or deleted) and are kept for **7 years**.
- **Access control** — People only get the access their role needs (admin, super_admin, clinician,
  or scribe). You can only see what you're authorized to see.
- **Automatic cleanup** — Encounter audio is deleted after **90 days**.
- **Login protection** — Repeated failed logins are rate-limited to slow down attackers.
- **Trusted partners** — Our transcription (Deepgram) and AI (Anthropic) partners have signed
  Business Associate Agreements (BAAs) to protect PHI.

---

## Your Responsibilities

By using Anot Health, you agree to:

1. **Access only what you need.** Look at patient information only when your job requires it
   (the "minimum necessary" rule).
2. **Keep your login private.** Never share your password or let someone use your account.
3. **Use strong, unique passwords** and log out of shared devices.
4. **Don't copy PHI** to personal devices, email, messaging apps, or unapproved tools.
5. **Lock your screen** when you step away.
6. **Speak up** if something looks wrong (see below).

---

## If You Suspect a Breach

A breach is any time PHI may have been seen, taken, or changed by someone who shouldn't have access —
for example, a lost device, a shared password, a suspicious login, or data sent to the wrong person.

**What to do — act fast, don't investigate alone:**

1. **Report it immediately** to **support@anot.health** (and **admin@anot.health** for anything
   urgent or serious).
2. **Don't try to cover it up or "fix it" quietly.** Reporting early protects patients and protects you.
3. **Write down what you saw** — what happened, when, and which patients or data might be involved.
4. **Preserve evidence** — don't delete logs, messages, or files related to the incident.

Reporting in good faith is always the right call. You will not be penalized for raising a concern.

---

## Acknowledgment & Sign-Off

> I confirm that I have read and understood this PHI Awareness Training. I understand what PHI is, how
> Anot Health protects it, and my responsibilities for keeping it safe. I agree to access PHI only as
> needed for my role, to keep my credentials secure, and to report any suspected breach immediately to
> support@anot.health.

| Field | Entry |
| --- | --- |
| Full name | ______________________________ |
| Role (admin / super_admin / clinician / scribe) | ______________________________ |
| Signature | ______________________________ |
| Date | ______________________________ |

*Retain the signed copy in the employee/contractor compliance file. Questions: admin@anot.health.*
