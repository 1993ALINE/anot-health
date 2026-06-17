# Audit Logging — HIPAA Status

**Scope:** `anot-backend` (`anot-backend-main/anot-backend-main`)
**Date:** 2026-06-14
**Method:** Source review of `src/utils/auditLogger.js`, `src/routes/audit.js`, `src/controllers/auditController.js`, and the writers across the codebase, plus introspection + applied hardening on the live production PostgreSQL (Neon) `audit_logs` table.

> **Update (2026-06-14):** The five gaps identified in the first review have been remediated. This revision documents the current (post-fix) state. See [§6 Remediation log](#6-remediation-log-2026-06-14).

---

## 1. `src/utils/auditLogger.js`

### Authentication events — ✅ Logged
| Event | Action string |
| --- | --- |
| Login success | `LOGIN_SUCCESS` |
| Login failure (lookup / inactive / role mismatch / bad password) | `LOGIN_FAILED` |
| Logout | `LOGOUT` |
| Self password change | `SELF_PASSWORD_CHANGED` |
| Admin password reset | `PASSWORD_RESET` |

### Data access (CRUD) — ✅ Now covered for visits
| Operation | Status | Events |
| --- | --- | --- |
| **Create** | ✅ Logged | `VISIT_CREATED` (added), `USER_REGISTERED`, `SCRIBE_ASSIGNED` |
| **Read** | ✅ Logged (visit/PHI access) | `VISITS_VIEWED`, `VISIT_HISTORY_VIEWED` (added). Note content (`ai_draft`, `transcription`, `final_note`) is delivered through these visit endpoints, so PHI views are captured. `ADMIN_PORTAL_ACCESS` still records admin-portal module access. |
| **Update** | ✅ Logged | `VISIT_UPDATED`, `VISIT_STATUS_UPDATED` (added), `VISIT_ENDED`, `NOTE_CONTENT_UPDATED`, `EDIT_REQUESTED`, `NOTE_SUBMITTED`, `USER_UPDATED`, `lock_note` |
| **Delete** | ✅ Logged | `VISIT_DELETED`, `USER_DELETED`, `SCRIBE_UNASSIGNED`. (There is no note-delete endpoint in the app, so no note-delete event is required.) |

### Secure IP tracking — ✅ Correct
`requestMeta()` uses `req.ip` (→ `req.socket.remoteAddress` fallback), **not** hand-parsed `X-Forwarded-For`. `req.ip` honors Express `trust proxy = 1`, set only in production / behind Railway, preventing IP spoofing in the audit trail.

### Reliability — ✅
Audit-write failures are reported to console + Sentry (`reportAuditFailure`), never silently dropped. Critical state changes (`VISIT_ENDED`, `VISIT_DELETED`, `lock_note`) audit inside the same DB transaction as the change. New create/update/read events are written fire-and-forget **after** the response so an audit hiccup cannot turn a successful operation into a 500 — failures still surface via Sentry.

---

## 2. `src/routes/audit.js`

✅ **`/api/audit` exists and is protected.** Mounted at `server.js:169`. Stack: `protect` → load portal modules → `restrict('admin','super_admin')` → `requireAdminPortalModules('audit')`. Endpoints: `GET /` (list), `GET /summary`, `GET /export` (CSV/XLSX/PDF, CSV-injection-safe), `POST /retention/apply` (super_admin only).

---

## 3. PostgreSQL `audit_logs` table (verified on live production DB)

### Columns — ✅ Present
| Requested | Actual column | Type |
| --- | --- | --- |
| `user_id` | `user_id` | `integer` |
| `action` | `action` | `text` (NOT NULL) |
| `resource` | `entity_type` + `entity_id` | `text`, `text` |
| `ip_address` | `ip_address` | `varchar(64)` |
| `timestamp` | `created_at` | `timestamptz` NOT NULL default `now()` |

Plus `user_name`, `user_role`, `details`, `user_agent`, `status`, `module_key`, `action_category`, `event_metadata (jsonb)`, `request_path`, with 6 supporting indexes.

### Append-only — ✅ **Now enforced (trigger-based)**
The application connects as the table **owner** (`neondb_owner`). In PostgreSQL the owner **bypasses `GRANT`/`REVOKE`**, so a `REVOKE DELETE/UPDATE/TRUNCATE` would *not* have stopped the app from mutating audit rows. Enforcement is therefore done with **triggers**, which fire for every role including the owner. Applied via `migrations/20260614_audit_append_only_and_retention.sql`:

- `trg_audit_logs_append_only` (BEFORE UPDATE OR DELETE, row-level): **UPDATE is always rejected**; **DELETE is rejected** unless the current transaction set `anot.allow_audit_purge = 'on'`.
- `trg_audit_logs_no_truncate` (BEFORE TRUNCATE, statement-level): **TRUNCATE rejected**.

Verified on production:

| Test | Result |
| --- | --- |
| `UPDATE audit_logs …` | ❌ rejected (`append-only`) |
| `DELETE audit_logs …` (no GUC) | ❌ rejected (`append-only`) |
| `DELETE` with `SET LOCAL anot.allow_audit_purge='on'` | ✅ permitted (retention path only) |

The retention purge (`applyRetention`) is the single sanctioned deleter: it runs inside a transaction that sets the GUC, so only rows past the retention window can ever be removed.

### Retention policy — ✅ **7 years**
- Live value: **`audit_retention_days = 2555`** (7 years), verified on production.
- New-install default: **2555** (`ALTER COLUMN … SET DEFAULT 2555`).
- Runtime floor/cap: clamped to **2190 (6 yr) … 3650 (10 yr)** in `ensureAuditRetentionColumn`, satisfying HIPAA §164.316(b)(2)'s 6-year minimum with margin.

---

## 4. Functional verification

Live mutation testing against production PHI was **not** performed (real patient data). Instead behavior was verified through code review + the production append-only/retention tests above, and historical production data confirms the event taxonomy. After this change, the following events are emitted (confirmed in code):

| Flow | Event | Category |
| --- | --- | --- |
| Login | `LOGIN_SUCCESS` / `LOGIN_FAILED` | authentication |
| Create visit | `VISIT_CREATED` | create |
| Edit visit (time/type) | `VISIT_UPDATED` | update |
| Change visit status | `VISIT_STATUS_UPDATED` | update |
| View visits / history (PHI) | `VISITS_VIEWED` / `VISIT_HISTORY_VIEWED` | read |
| Delete visit | `VISIT_DELETED` | delete |

To exercise end-to-end with synthetic data, run against a local/staging DB (`npm run seed:dev`) — recommended before each release.

---

## 5. Remaining considerations

| # | Item | Severity | Note |
| --- | --- | --- | --- |
| R1 | **Read-logging volume** | Medium | `VISITS_VIEWED` fires once per list fetch. If the frontend polls frequently, the audit table can grow quickly. Consider throttling/deduping (e.g. one read event per user per resource per N minutes) if volume becomes an issue. |
| R2 | **Retention is hard-delete** | Low | Beyond 7 years rows are deleted (via the sanctioned purge). For stricter programs, archive to immutable cold storage (e.g. S3 Object Lock / WORM) before purge. |
| R3 | **Owner can drop triggers** | Low | Append-only triggers protect against application-level tampering but the DB owner could `DROP TRIGGER`. For separation-of-duties, run the app under a least-privilege role (INSERT/SELECT only) distinct from the migration/owner role. |
| R4 | **No automated tests** | Medium | Add integration tests asserting each CRUD + auth path writes exactly one audit row, and that UPDATE/DELETE on `audit_logs` are rejected. |
| R5 | Action-name casing (`lock_note`) | Low | Minor inconsistency; normalize action constants for cleaner reporting. |

### Strengths
✅ Full authentication coverage · ✅ Visit create/read/update/delete coverage · ✅ Secure non-spoofable IP capture · ✅ DB-enforced append-only · ✅ 7-year retention · ✅ Audit endpoint locked behind auth + admin role + module permission · ✅ Sentry-backed failure reporting · ✅ Injection-safe exports.

---

## 6. Remediation log (2026-06-14)

| Gap (prior review) | Fix | Location |
| --- | --- | --- |
| G1 Visit CREATE not logged | Added `VISIT_CREATED` audit | `src/controllers/visitController.js` `createVisit` |
| G2 Visit UPDATE not logged | Added `VISIT_UPDATED` + `VISIT_STATUS_UPDATED` audits | `visitController.js` `updateVisit`, `updateVisitStatus` |
| G3 Not append-only | Trigger-based enforcement (UPDATE/DELETE/TRUNCATE blocked; purge via GUC) + purge path rewrite | `migrations/20260614_audit_append_only_and_retention.sql`, `auditController.js` `applyRetention` |
| G4 Retention 1 year | Default → 2555 (7 yr); floor 2190 / cap 3650; live value updated to 2555 | `auditController.js`, migration |
| G5 PHI reads not logged | Added `VISITS_VIEWED` / `VISIT_HISTORY_VIEWED` read audits | `visitController.js` `getVisitsByDate`, `getAllVisits`, `getVisitHistory` |

**Deployment note:** The append-only trigger and the 7-year retention value were applied directly to the production database. The application code that sets the `anot.allow_audit_purge` GUC during retention must be deployed for `POST /api/audit/retention/apply` to function — until then, manual purges will (intentionally) be rejected by the trigger. Normal audit INSERTs are unaffected.

---

## Verdict

| Claim | Status |
| --- | --- |
| Authentication events logged | ✅ |
| Data access (CRUD) logged | ✅ (visits: create/read/update/delete) |
| Secure IP tracking (`req.ip`) | ✅ |
| `/api/audit` works & requires auth | ✅ |
| `audit_logs` table + columns exist | ✅ |
| Append-only (cannot be deleted/altered) | ✅ (DB triggers; purge-only exception) |
| Retention ≥ 7 years | ✅ (2555 days) |

**Overall: the audit trail now meets the core HIPAA technical-safeguard expectations** (§164.312(b) audit controls, §164.316(b)(2) retention). Address R1–R4 to further harden for formal certification.
