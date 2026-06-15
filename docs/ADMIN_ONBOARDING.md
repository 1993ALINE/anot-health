# Admin Onboarding Guide

**Anot Health** · Version 1.1 · June 16, 2026

Welcome. This guide walks administrators through the day-to-day tasks of running Anot Health: signing
in, creating and managing staff, resetting passwords, reviewing audit logs, enabling/disabling
accounts, monitoring system health, and troubleshooting common issues.

> **Roles at a glance:** `super_admin` (platform governance, sole authority for audit retention
> purges and System Health), `admin` (day-to-day administration, scoped by granted portal modules),
> `clinician` (records encounters, reviews/locks notes), `scribe` (drafts notes, uploads to EHR),
> and `qps` (quality reviewer / grader). What you can see and do depends on your role and the admin
> portal modules granted to you.

> **A note on this guide:** wording and labels below match the current build. Where a step depends on
> being a `super_admin`, it is called out explicitly.

---

## 1. Logging In

1. Open the application URL: **https://app.anot.health** (your CloudFront/app domain).
2. Enter your **email** (e.g. `atiqur@anot.health` or your assigned admin email) and **password**,
   then submit.
3. **First login (or after a password reset):** two modals appear in sequence before you reach the
   dashboard:
   - **Change Password modal** — set a new password with at least **12 characters** including an
     uppercase letter, a lowercase letter, a number, and a special character. Common/default
     passwords are rejected.
   - **PHI awareness training modal** — read and **acknowledge** the HIPAA/PHI training. This is
     required and is recorded in the audit log.
4. You land on the **admin dashboard** (it opens on the first module you have access to, e.g.
   **Overview**).

Sessions expire after **8 hours**; you'll need to sign in again after that. The sidebar lists only
the modules your role/permissions allow.

---

## 2. Creating New Clinicians (and Other Staff)

Staff are managed under **per-role tabs** in the left sidebar — there is no single "Users" tab.
Pick the tab for the role you're adding: **Clinicians**, **Scribes**, **QPS Staff**, or **Admins**.

To create a clinician:

1. In the sidebar, open the **Clinicians** tab.
2. Click **+ Add Clinician** (top-right of the table; if the list is empty, use the **Add Clinician**
   button in the empty state).
3. A **Register new Clinician** modal opens. Fill in:
   - **Role** — defaults to Clinician (you can switch to Scribe/QPS here; **Admin** appears only for
     super-admins).
   - **Full Name \*** (required)
   - **Email \*** (required, e.g. `name@anot.health`)
   - **Phone** (optional)
   - **Specialty** (optional, e.g. Internal Medicine)
   - **NPI Number** (optional, clinicians only)
   - **License** (optional, clinicians only)
   - **Initial password (optional)** — **leave this blank** so the system generates a secure
     temporary password.
4. Click **Create Clinician account** (the button label matches the selected role, e.g. "Create
   Scribe account"). Confirm the prompt.
5. The system shows the **temporary password once**. Use the **copy** action to copy it to your
   clipboard.
6. **Share it securely** with the clinician (in person, or via a secure channel your clinic
   approves). The clinician will be **forced to change it** on first login and must acknowledge PHI
   training.

**Notes & limits:**
- The new user is created **active**, with a forced password change + PHI training on first login.
- Only a **super_admin** can create **admin** accounts. The **super_admin** role cannot be created
  or assigned through the system.
- Admins can only add the staff roles their granted portal modules permit.
- Every creation is recorded in the audit log (`USER_REGISTERED`); the password is never logged.

---

## 3. Resetting Clinician (and Staff) Passwords

1. Open the relevant role tab (e.g. **Clinicians**) and find the user (use the search box if needed).
2. In that user's row, click **🔑 Reset**.
3. In the **Reset password** modal, click **Reset & generate password** and confirm.
4. The system generates a **random temporary password** and shows it **once** — copy it and share it
   securely with the user.
5. On their next login the user is **forced to change** the password and (if not already done)
   acknowledge PHI training.

**Important:** You cannot reset **your own** password this way (to avoid locking yourself out) — ask
another admin. The reset is audited (`PASSWORD_RESET`); the password itself is never logged.

---

## 4. Viewing Audit Logs

Open the **Audit Logs** tab (🔍 in the sidebar; requires the `audit` module permission).

1. **List / filter** audit events by **date range**, **action type** (login, create, delete, reset,
   etc.), **status**, **module**, and **user email**.
2. The **Summary** view surfaces indicators like failed-login counts and recent critical events —
   useful for a quick compliance/security pulse.
3. **Export** logs to **CSV / XLSX / PDF** when you need a record (exports are CSV-injection-safe).
4. Review entries for compliance and security investigations.

Audit logs are **append-only** — they cannot be edited or deleted outside the sanctioned retention
purge. Retention is **7 years**. The **retention purge** (deleting records older than the window) is
restricted to **super_admin** only and is itself audited.

---

## 5. Disabling / Enabling Users

1. Open the relevant role tab and find the user.
2. In the user's row, click **Disable** (for an active user) or **Enable** (for an inactive user).
   The status badge shows **● Active** or **○ Inactive**.
3. Disabling a user blocks new logins and **revokes active sessions within ~60 seconds** (the auth
   cache is invalidated immediately on toggle). Re-enable the same way.

**Notes:**
- The **system Super Admin** account cannot be activated/deactivated here (the control is disabled
  on that row).
- Prefer **Disable** over deletion for anyone tied to clinical records — deletion is blocked when a
  user has linked visits/notes/grades (to prevent orphaned clinical data). Disabling preserves the
  audit and clinical trail.
- Status changes are audited (`USER_ACTIVATED` / `USER_DEACTIVATED`).

---

## 6. System Health Monitoring

> **Access:** The **System Health** tab (💓 in the sidebar) is **Super Admin–only**. Regular admins
> won't see it; the backend also enforces `super_admin`.

The page auto-refreshes every **30 seconds**; use **Refresh Now** for an immediate check.

1. Open the **System Health** tab.
2. Read the **overall status** orb at the top:
   - **Healthy (green):** all systems operational.
   - **Degraded (yellow):** at least one component is reporting an error.
   - **Critical (red):** multiple components are down.
3. Review each **component card** — **Database**, **Deepgram**, **Anthropic**, and **S3** — each
   shows **Operational/Error**, **latency (ms)**, a status message, and when it was last tested.
4. Review the **Metrics** row: **Total Users**, **Active Sessions**, **Errors (24h)** (highlighted
   when > 0), and **API Calls (24h)**.
5. If status is **yellow/red**, check the failing component:
   - **Deepgram** → transcription provider (API key/quota — see Settings and Troubleshooting).
   - **Anthropic** → AI note generation provider (API key — see Settings).
   - **Database / S3** → infrastructure; check provider status and recent deploys.
6. Click **Refresh Now** to re-run the checks after making a change.

> Additional monitoring outside this tab: the backend health endpoint `GET /` returns
> `✅ Anot API is running` (via CloudFront, `https://<your-domain>/api/`). Application errors are
> reported to **Sentry** (PHI scrubbed) and operational logs ship to **CloudWatch**.

---

## 7. Troubleshooting Common Issues

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Clinician/staff can't log in | Account doesn't exist, is **Inactive**, or they haven't completed first-login steps | Confirm the user exists and is **Active**; have them complete the forced password change + PHI training |
| "Account has been deactivated" | User status is inactive | Re-enable via **Enable** on the user's row |
| "Session expired. Please log in again." | Role changed, or token aged out (8h) | User signs in again |
| "Too many attempts" on login | Rate limit hit (20 / 15 min on auth) | Wait 15 minutes, then retry |
| Transcription not producing text | **Deepgram** API key missing/invalid or quota exceeded | Set/refresh the **Deepgram API key** in **Settings**; check for 401 (bad key) or 429 (quota) in logs / System Health |
| "AI draft unavailable" in notes | **Anthropic** key missing or AI generation disabled | Add the **Anthropic API key** and enable AI generation in **Settings** |
| Deepgram call slow/stalled | Network/provider latency | Calls time out at 30s and retry with backoff; long sync transcriptions can raise `deepgram_timeout_ms` |
| System Health shows yellow/red | One or more components erroring | Open **System Health**, identify the failing component, fix it (key/infra), then **Refresh Now** |
| CORS / mixed-content errors in browser | Frontend built with wrong API URL, or CloudFront origin not allowed | Ensure frontend `VITE_API_URL` and backend `CORS_ORIGINS` match the CloudFront domain |
| Can't delete a user | User has linked clinical records | **Disable** instead of deleting |

**Escalation:** For suspected security incidents or PHI exposure, follow `BREACH_RESPONSE_PLAN.md`
and report immediately to **support@anot.health** (and **admin@anot.health** for urgent issues).

---

## Support

- **Support:** support@anot.health
- **Administrator / Security Officer:** admin@anot.health
- **Privacy / Compliance:** privacy@anot.health
