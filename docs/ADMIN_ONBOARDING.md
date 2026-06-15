# Admin Onboarding Guide

**Anot Health** · Version 1.0 · June 16, 2026

Welcome. This guide walks administrators through the day-to-day tasks of running Anot Health: signing
in, managing users, resetting passwords, reviewing audit logs, enabling/disabling accounts, checking
system health, and troubleshooting common issues.

> **Roles at a glance:** `super_admin` (platform governance, sole authority for audit retention
> purges), `admin` (day-to-day administration, scoped by portal modules), `clinician`, `scribe`, and
> `qps` (quality reviewer). What you can see and do depends on your role and the admin portal modules
> granted to you.

---

## 1. How to Log In

1. Go to the application URL (your CloudFront/app domain, e.g. `https://app.anot.health`).
2. Enter your **email** and **password** and submit.
3. **First login or after a password reset:** you'll be prompted to **change your password**. Choose
   one with at least **12 characters** including an uppercase letter, a lowercase letter, a number,
   and a special character. Common/default passwords are rejected.
4. **PHI awareness training:** before reaching the dashboard, you must **acknowledge the PHI training**
   prompt. This is required by HIPAA and is recorded in the audit log.
5. You'll land on the **admin dashboard**.

Sessions expire after **8 hours**; you'll need to sign in again after that.

---

## 2. Create New Clinicians (and Other Users)

From the **Admin panel → Users / Clinicians**:

1. Click **Add / Create user** (or the equivalent button for the staff type).
2. Enter **name, email, role**, and optional fields (specialty, phone, NPI, license).
3. **Password:** leave it blank to have the system generate a **secure temporary password**. It is
   shown **once** — copy it and share it with the user through a secure channel. The user will be
   **forced to change it** on first login.
4. Save. The new user is created **active**, with PHI training required on first login.

**Notes & limits:**
- Only a **super_admin** can create **admin** accounts. The **super_admin** role cannot be created or
  assigned through the system.
- Admins can only create/manage staff roles permitted by their granted portal modules.
- Every user creation is recorded in the audit log (`USER_REGISTERED`).

---

## 3. Reset a User's Password

From the user's row in the Admin panel:

1. Choose **Reset password**.
2. The system generates a **random 16-character temporary password** and returns it **once** — share
   it securely with the user.
3. The user is **forced to change** the password on their next login.

**Important:** You cannot reset **your own** password this way (to avoid locking yourself out) — ask
another admin. The reset is audited (`PASSWORD_RESET`); the password itself is never logged.

---

## 4. View Audit Logs

From **Admin panel → Audit** (requires the `audit` module permission):

- **List / filter** audit events (by date, action, status, module, user).
- **Summary** view shows indicators like failed-login counts and recent critical events.
- **Export** logs to CSV/XLSX/PDF (exports are CSV-injection-safe).
- **Retention purge** (delete records older than the 7-year window) is restricted to **super_admin**
  only and is itself audited.

Audit logs are **append-only** — they cannot be edited or deleted outside the sanctioned retention
purge. Retention is **7 years**.

---

## 5. Disable / Enable Users

From the user's row:

1. Use **Toggle status** (Activate / Deactivate).
2. Deactivating a user blocks new logins and **revokes active sessions within ~60 seconds** (the auth
   cache is invalidated immediately on toggle).
3. Re-enable the same way.

**Notes:**
- The **super_admin** account status cannot be changed through the API.
- Prefer **deactivate** over **delete** for anyone tied to clinical records — deletion is blocked when
  a user has linked visits/notes/grades (to prevent orphaned clinical data). Deactivation preserves
  the audit and clinical trail.
- Status changes are audited (`USER_ACTIVATED` / `USER_DEACTIVATED`).

---

## 6. Monitor System Health

- **Backend health check:** `GET /` returns a JSON status (`✅ Anot API is running`). Through
  CloudFront use `https://<your-domain>/api/`.
- **Overview / stats:** The admin **Overview** module shows counts (clinicians, scribes, qps, admins,
  notes total / pending / uploaded) — a quick activity pulse.
- **Error monitoring:** Application errors are reported to Sentry (with PHI scrubbed). Operational
  logs ship to CloudWatch.
- **Audit summary:** Use the audit summary for failed-login spikes and recent critical events.

> The platform does not yet include a single "all dependencies green" dashboard (DB / Deepgram /
> Anthropic). For now, the health endpoint plus the transcription troubleshooting below cover most
> needs.

---

## 7. Troubleshooting Common Issues

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| User can't log in after creation/reset | They must change the temp password and acknowledge PHI training first | Have them complete the forced password change + training prompt |
| "Account has been deactivated" | User status is inactive | Re-activate via Toggle status |
| "Session expired. Please log in again." | Role changed, or token aged out | User signs in again |
| Transcription not producing text | Deepgram API key missing/invalid, or quota exceeded | Set/refresh the **Deepgram API key** in Admin → Settings; check for 401 (bad key) or 429 (quota) in logs |
| "AI draft unavailable" placeholder in notes | Anthropic key missing or AI generation disabled | Add the **Anthropic API key** and enable AI generation in Admin → Settings |
| Deepgram call slow/stalled | Network/provider latency | Calls now time out at 30s and retry with backoff; long sync transcriptions can raise `deepgram_timeout_ms` |
| Login throttled ("Too many attempts") | Rate limit hit (20 / 15 min on auth) | Wait 15 minutes, then retry |
| CORS / mixed-content errors in browser | Frontend built with wrong API URL, or CloudFront origin not allowed | Ensure frontend `VITE_API_URL` and backend `CORS_ORIGINS` match the CloudFront domain |
| Can't delete a user | User has linked clinical records | Deactivate instead of deleting |

**Escalation:** For suspected security incidents or PHI exposure, follow `BREACH_RESPONSE_PLAN.md` and
report immediately to **support@anot.health** (and **admin@anot.health** for urgent issues).

---

## Support

- **Support:** support@anot.health
- **Administrator / Security Officer:** admin@anot.health
- **Privacy / Compliance:** privacy@anot.health
