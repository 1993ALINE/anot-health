# Anot Health — Platform Documentation

**Version 1.0 · June 16, 2026**

A comprehensive technical and operational guide to the Anot Health platform: a HIPAA-aware
clinical documentation system that turns recorded patient encounters into reviewed, approved
clinical notes.

> **Audience:** engineers, operators (`super_admin`), and onboarding staff. This document is the
> single source of truth for architecture, deployment, data model, and operations. For
> task-specific procedures see the companion docs referenced throughout
> (`docs/COST_MONITORING.md`, `docs/DISASTER_RECOVERY.md`, `SECURITY_AND_COMPLIANCE_MANUAL.md`,
> `BREACH_RESPONSE_PLAN.md`).

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Architecture](#2-architecture)
3. [System Components](#3-system-components)
4. [Deployment Architecture](#4-deployment-architecture)
5. [User Roles & Permissions](#5-user-roles--permissions)
6. [Key Workflows](#6-key-workflows)
7. [API Endpoints](#7-api-endpoints)
8. [Database Schema](#8-database-schema)
9. [Security & Compliance](#9-security--compliance)
10. [Configuration & Environment Variables](#10-configuration--environment-variables)
11. [Monitoring & Logging](#11-monitoring--logging)
12. [Disaster Recovery](#12-disaster-recovery)
13. [Cost Monitoring](#13-cost-monitoring)
14. [Known Limitations & Future Work](#14-known-limitations--future-work)
15. [Troubleshooting](#15-troubleshooting)
16. [Useful Links & References](#16-useful-links--references)
17. [Deployment Checklists](#17-deployment-checklists)
18. [Contact & Support](#18-contact--support)

---

## 1. Platform Overview

### What is Anot Health?

Anot Health is a clinical documentation platform that converts recorded patient encounters into
structured, reviewed clinical notes. It removes the manual burden of charting by recording the
visit audio, transcribing it with speech-to-text, drafting a note with AI, and then routing that
draft through a human review-and-approval chain before it is uploaded to the EHR. Every action that
touches protected health information (PHI) is audit-logged for HIPAA compliance.

### Core Workflow

```
record  →  transcribe  →  AI draft  →  scribe review  →  clinician approve  →  EHR upload
```

1. **Record** — a clinician records the patient encounter (microphone audio) against a visit.
2. **Transcribe** — the audio is sent to Deepgram (speech-to-text); segments are stored on the note.
3. **AI draft** — Anthropic Claude turns the transcript into a structured clinical note draft.
4. **Review** — a scribe reviews/edits the draft and submits it as ready.
5. **Approve** — the clinician reviews and locks/approves the note.
6. **Upload** — the approved note is uploaded to the EHR (currently a manual step).
7. **Quality** — QPS staff grade submitted notes on accuracy, completeness, terminology, and formatting.

### Technology Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, Vite 8, React Router 7, Recharts |
| Backend | Node.js 22, Express 5 |
| Database | PostgreSQL (AWS RDS) |
| Audio storage | AWS S3 |
| CDN / hosting | AWS CloudFront + S3 (static) |
| Backend host | AWS Elastic Beanstalk |
| Speech-to-text | Deepgram |
| AI note generation | Anthropic Claude |
| Error tracking | Sentry (PHI-scrubbed) |
| Audit/log shipping | AWS CloudWatch Logs |

### Key Integrations

- **Deepgram** — speech-to-text transcription (webhook/callback mode).
- **Anthropic Claude** — AI clinical-note drafting from transcripts.
- **AWS** — RDS (PostgreSQL), S3 (audio), CloudFront (CDN), Elastic Beanstalk (API host),
  CloudWatch (logs/metrics).

---

## 2. Architecture

```
                         ┌─────────────────────────────┐
                         │           Browser           │
                         │  React 19 SPA (Vite build)  │
                         └──────────────┬──────────────┘
                                        │ HTTPS
                          ┌─────────────▼─────────────┐
                          │   CloudFront (CDN/TLS)     │
                          │  static assets + /api/*    │
                          └───────┬───────────┬────────┘
                       static S3  │           │ /api/* proxy
                    ┌─────────────▼──┐   ┌─────▼───────────────────┐
                    │  S3 (frontend) │   │  Elastic Beanstalk      │
                    │  static site   │   │  Node.js/Express API    │
                    └────────────────┘   └───┬─────────┬───────┬───┘
                                             │         │       │
                              ┌──────────────▼──┐  ┌───▼────┐  ▼ (external APIs)
                              │ RDS PostgreSQL  │  │ S3     │  Deepgram / Anthropic
                              │ (managed, enc.) │  │ audio  │
                              └─────────────────┘  └────────┘
                                             │
                                       CloudWatch Logs + Sentry
```

### Frontend Architecture

- **React 19** single-page app built with **Vite 8**, routed by **react-router-dom 7**,
  charts via **Recharts**.
- Built to static assets (`vite build` → `dist/`) and served from **S3** behind **CloudFront**.
- Talks to the backend exclusively through the REST API base URL configured in
  `.env.production` (`VITE_API_URL`).

### Backend Architecture

- **Node.js 22** + **Express 5** API, entry point `src/server.js`.
- Hardened with **helmet** (CSP, HSTS), explicit security headers, **CORS** allow-list, and
  **express-rate-limit** (global + stricter auth limiter).
- Schema is applied idempotently at startup (`ensureUserProfileSchema`) so fresh deploys have the
  required columns before serving traffic.
- Deployed on **AWS Elastic Beanstalk** with auto-scaling.

### Database

- **PostgreSQL** managed by **AWS RDS** (`anot-postgres`).
- Encrypted at rest (AES-256), automated daily snapshots with point-in-time recovery.

### Storage

- Audio recordings are stored in **S3** (`anot-audio-625242092266`) with **AES-256** server-side
  encryption. Audio is never served from a public URL — access is only via the authenticated
  `GET /api/audio/:visitId` route, which issues short-lived presigned URLs.

### Deployment

- **Frontend:** S3 static hosting + CloudFront CDN/TLS.
- **Backend:** Elastic Beanstalk (auto-scaling Node.js environment).
- **Database:** RDS managed PostgreSQL.

---

## 3. System Components

### Frontend (`anot-frontend-main`)

| Property | Value |
| --- | --- |
| Technology | React 19, Vite 8, React Router 7, Recharts |
| Build | `npm run build` (outputs static assets to `dist/`) |
| Dev server | `npm run dev` (Vite, default port 5173) |
| Deploy | Upload `dist/` to S3, served via CloudFront |
| Config | `.env.production` (`VITE_API_URL`) |

> **Styling note:** the UI is built with utility CSS conventions; verify the exact toolchain in the
> frontend repo before changing the build. The deployable artifact is always the static `dist/`
> output from `vite build`.

### Backend (`anot-backend-main`)

| Property | Value |
| --- | --- |
| Technology | Node.js 22, Express 5 |
| Entry point | `src/server.js` (`npm start`) |
| Database | PostgreSQL (RDS) via `pg` connection pool |
| Deploy | Elastic Beanstalk |
| Key route groups | `/api/auth`, `/api/visits`, `/api/notes`, `/api/users`, `/api/patients`, `/api/assignments`, `/api/audio`, `/api/audit`, `/api/settings`, `/api/support`, `/api/webhooks`, `/api/admin` |

Mounted route map (`src/server.js`):

```text
/api/auth        → authentication, profile, password, PHI-training gate
/api/webhooks    → Deepgram transcription callbacks
/api/users       → user/staff management (admin portal)
/api/patients    → patient records
/api/visits      → visits, recording lifecycle, transcription triggers
/api/notes       → note drafts, submit, approve, EHR upload, grading
/api/assignments → scribe ↔ clinician assignments
/api/audio       → authenticated audio retrieval (presigned URLs)
/api/audit       → audit log listing, summary, export, retention
/api/settings    → system/AI settings (encrypted)
/api/support     → support requests
/api/admin       → system health dashboard (super_admin)
```

### Database (PostgreSQL)

| Property | Value |
| --- | --- |
| Host | `anot-postgres.c5casia24do8.ap-southeast-1.rds.amazonaws.com` |
| Application user | `anot_app` |
| Core tables | `users`, `patients`, `visits`, `notes`, `audit_logs`, `grades`, `scribe_assignments` |
| Backup | Automated daily RDS snapshots (7-day retention, PITR) |
| Encryption | At-rest AES-256 |

> **Note:** the assignments table is named `scribe_assignments` (clinician ↔ scribe), and the
> quality table is `grades`. See [§8 Database Schema](#8-database-schema) for the authoritative
> column lists.

### Storage (S3)

| Property | Value |
| --- | --- |
| Bucket | `anot-audio-625242092266` |
| Region | `ap-southeast-1` |
| Purpose | Store visit audio recordings |
| Lifecycle | Auto-delete after 90 days |
| Encryption | AES-256 (server-side, `ServerSideEncryption: AES256`) |
| Access | Private only — via authenticated `GET /api/audio/:visitId` with 7-day presigned URLs |

### API Services

- **Deepgram** — speech-to-text. Health-probed via `GET https://api.deepgram.com/v1/projects`.
- **Anthropic Claude** — AI note generation. Health-probed via `GET https://api.anthropic.com/v1/models`.
- **AWS** — RDS, S3, CloudFront, Elastic Beanstalk, CloudWatch Logs.

---

## 4. Deployment Architecture

| Tier | Service | Notes |
| --- | --- | --- |
| Frontend | CloudFront (CDN) + S3 (static hosting) | TLS termination at CloudFront; static `dist/` in S3 |
| Backend | Elastic Beanstalk | Auto-scaling Node.js environment; trusts 1 proxy hop in production |
| Database | RDS (managed PostgreSQL) | Daily snapshots, encryption at rest, PITR |
| Monitoring | CloudWatch + Sentry | App/EB logs in CloudWatch; error tracking (PHI-scrubbed) in Sentry |

**Request path:** Browser → CloudFront → (static from S3) / (`/api/*` to the Elastic Beanstalk
backend) → RDS / S3 / Deepgram / Anthropic.

> The frontend's production API base URL lives in
> `anot-frontend-main/.env.production` (`VITE_API_URL`). The backend enforces a
> CORS allow-list (configurable via the `CORS_ORIGINS` env var) so only approved origins may call
> the API.

---

## 5. User Roles & Permissions

Roles are canonicalized in `src/utils/roles.js`. The hierarchy is
`super_admin > admin > {clinician, scribe, qps}`.

| Role | Capabilities |
| --- | --- |
| **Super Admin** | Full system access. Bootstrap-only role (never created via API). Can create `admin` accounts, manage all users, grant admin portal modules, view audit logs, apply audit retention, view performance reports, and access the System Health dashboard (`/api/admin/health`). |
| **Admin** | Create/manage non-elevated staff (`clinician`, `scribe`, `qps`), manage assignments, view audit logs, payroll, and settings — gated per-account by granted **admin portal modules**. Cannot manage `super_admin`; can only manage other `admin` accounts if granted the `admins` module. |
| **Clinician** | Create and record visits, trigger transcription, view/edit and approve/lock their own notes, request edits, view their own note history. |
| **Scribe** | Review transcripts and AI drafts for assigned clinicians, save/submit drafts, trigger transcription/draft generation, upload approved notes to EHR, view their grades. |
| **QPS** | Quality & Performance Standards — grade/quality-check submitted notes (accuracy, completeness, terminology, formatting, overall), view performance reports. |

### Admin Portal Modules

Admin accounts are further scoped by **module keys** (granted by Super Admin):
`overview`, `clinicians`, `scribes`, `qps`, `admins`, `assignments`, `payroll`, `audit`,
`settings`, `system-profile`. When an admin's modules are unset (`null`), they receive all modules
**except** `admins`. Module access is enforced by middleware (`requireAdminPortalModules`) and
audited (`logAdminPortalModuleAccess`).

---

## 6. Key Workflows

### 6.1 User Login Flow

1. Client `POST /api/auth/login` with `{ email, password }`.
2. Server looks up the user, verifies the bcrypt password hash, and returns a **single generic
   error** (`Invalid email or password.`) for any credential/role/status failure to prevent account
   enumeration.
3. **Gates before a full session is issued:**
   - **Forced password change** (`force_password_change = true`) — temp passwords, admin resets, and
     seeds require the user to set a new password.
   - **PHI training gate** — if the account has not acknowledged the current PHI training revision
     (`phi_training_acknowledged` / `phi_training_version`), login returns a short-lived
     `temporaryToken`; the client must call `POST /api/auth/acknowledge-phi-training` to complete it.
4. On success, the server issues a **JWT** (`expiresIn` default **8h**, configurable via
   `JWT_EXPIRES_IN`) carrying `id, name, email, role, specialty`.
5. The login endpoint is brute-force protected (10 failed attempts / 15 min per IP; successful
   logins are not counted).

### 6.2 Recording an Encounter

1. Clinician creates a visit: `POST /api/visits` (patient, visit type, date/time).
2. Audio is recorded in the browser and uploaded against the visit; the audio file is stored in S3
   (path saved on `visits.audio_file`).
3. Visit `transcription_status` tracks lifecycle: `idle → processing → completed`.

### 6.3 Transcription Pipeline

1. Trigger: `POST /api/visits/:id/transcribe` (or legacy `/generate-ai`), allowed for clinician/scribe.
2. The server validates audio exists, resolves any stuck `processing` state, then returns `202`
   and runs the AI pipeline asynchronously (`runAIPipeline`).
3. Audio is fetched from S3, sent to **Deepgram**; transcription completes via webhook
   (`/api/webhooks`) in callback mode. Segments are stored on `notes.transcription`.

### 6.4 AI Note Generation

1. With a transcript present, `generateAINote` calls **Anthropic Claude** with patient/visit context
   (name, MRN, visit type/date) to produce a structured draft.
2. The draft is stored on `notes.ai_draft`. If no Anthropic key is configured, a clear placeholder
   message is stored instead so the gap is visible in the editor.
3. Scribes can re-run draft generation via `POST /api/visits/:id/generate-draft` while the note is
   still `pending`/`draft` (locked notes return `409`).

### 6.5 Scribe Review

1. Scribe lists assigned work and opens the note (`GET /api/notes/visit/:visitId`).
2. Scribe edits and saves a working draft (`POST /api/notes/draft`).
3. When ready, scribe submits (`PUT /api/notes/:id/submit`) — status moves toward `submitted`.

### 6.6 Clinician Approval

1. Clinician reviews the submitted note, edits content (`PUT /api/notes/:id`), or requests changes
   (`PUT /api/notes/:id/request-edit`).
2. Clinician locks/approves the note (`POST /api/visits/:id/lock-note`), freezing further edits.

### 6.7 EHR Upload (Manual)

1. After approval, the note is uploaded to the EHR via `POST /api/notes/:id/upload-ehr`.
2. This records `ehr_uploaded_at` / `ehr_uploaded_by` and sets the note status to `uploaded`.
   **EHR upload is currently a manual action** (see [§14](#14-known-limitations--future-work)).

### 6.8 Quality Grading (QPS)

1. QPS reviews submitted/uploaded notes and submits a grade (`POST /api/notes/grade`).
2. Grades capture `accuracy`, `completeness`, `terminology`, `formatting`, `overall_score`, and an
   optional `comment` (stored in the `grades` table, one row per note).

---

## 7. API Endpoints

All routes are prefixed with the API base URL (e.g. `https://<cloudfront-domain>/api`). Unless noted,
endpoints require a valid JWT (`Authorization: Bearer <token>`) via the `protect` middleware, and
role/module restrictions are enforced server-side. The global limiter allows 100 req/15min in
production; `/api/auth` is limited to 20 req/15min.

### Authentication — `/api/auth`

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | Public (rate-limited) | Authenticate; returns JWT or a gate (`force_password_change` / PHI training `temporaryToken`) |
| POST | `/api/auth/acknowledge-phi-training` | Temp token (rate-limited) | Complete the PHI-training gate and issue a full session |
| POST | `/api/auth/register` | Admin, Super Admin | Create a new staff account |
| POST | `/api/auth/logout` | Authenticated | Record sign-out (client discards token) |
| GET | `/api/auth/me` | Authenticated | Get current user profile |
| PUT | `/api/auth/me` | Authenticated | Update current user profile |
| PUT | `/api/auth/change-password` | Authenticated (rate-limited) | Change own password |

### Visits — `/api/visits`

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/api/visits/` | Clinician, Scribe, QPS | List visits (scoped per role) |
| GET | `/api/visits/my` | Clinician | Today's visits by date |
| GET | `/api/visits/history` | Clinician | Visit history |
| POST | `/api/visits/` | Clinician | Create a visit |
| PUT | `/api/visits/:id` | Clinician | Update visit |
| PUT | `/api/visits/:id/end` | Clinician | End/finalize the encounter |
| PUT | `/api/visits/:id/status` | Clinician, Scribe | Update visit status |
| DELETE | `/api/visits/:id` | Clinician | Delete a visit |
| POST | `/api/visits/:id/transcribe` | Clinician, Scribe | Queue transcription |
| POST | `/api/visits/:id/generate-ai` | Clinician, Scribe | Legacy alias for transcribe |
| POST | `/api/visits/:id/generate-draft` | Scribe | Generate AI draft from saved transcript |
| POST | `/api/visits/:id/lock-note` | Clinician | Lock/approve the note |

### Notes — `/api/notes`

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/api/notes/` | Admin, Super Admin, QPS | List all notes |
| GET | `/api/notes/my` | Scribe | Notes assigned to the scribe |
| GET | `/api/notes/clinician` | Clinician | Clinician's own notes |
| GET | `/api/notes/my-grades` | Scribe | Grades received on the scribe's notes |
| GET | `/api/notes/visit/:visitId` | Authenticated | Get the note for a visit |
| POST | `/api/notes/draft` | Scribe | Save a working draft |
| PUT | `/api/notes/:id` | Clinician | Update note content |
| PUT | `/api/notes/:id/submit` | Scribe | Submit note as ready |
| PUT | `/api/notes/:id/request-edit` | Clinician | Request changes |
| POST | `/api/notes/:id/upload-ehr` | Scribe | Mark note uploaded to EHR |
| POST | `/api/notes/grade` | QPS | Submit a quality grade |

### Users — `/api/users` (Admin portal, module-gated)

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/api/users/` | Admin, Super Admin | List users |
| GET | `/api/users/stats` | Admin, Super Admin (`overview`) | Admin dashboard stats |
| GET | `/api/users/payroll` | Admin, Super Admin (`payroll`) | Payroll report |
| GET | `/api/users/performance` | QPS, Super Admin | Performance report |
| GET | `/api/users/role/:role` | Admin, Super Admin, QPS | List users by role |
| GET | `/api/users/:id` | Admin, Super Admin | Get a user |
| PUT | `/api/users/:id` | Admin, Super Admin | Update a user |
| PATCH | `/api/users/:id/admin-modules` | Super Admin (`admins`) | Grant admin portal modules |
| PUT | `/api/users/:id/toggle-status` | Admin, Super Admin | Disable/enable a user |
| PUT | `/api/users/:id/reset-password` | Admin, Super Admin | Reset a user's password |
| PUT | `/api/users/:id/rate` | Admin, Super Admin | Set pay rate per note |
| DELETE | `/api/users/:id` | Admin, Super Admin | Delete a user |

### Assignments — `/api/assignments`

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/api/assignments/` | Admin, Super Admin | List scribe↔clinician assignments |
| POST | `/api/assignments/` | Admin, Super Admin (`assignments`) | Assign a scribe to a clinician (reassigns existing open visits) |
| GET | `/api/assignments/my-clinicians` | Scribe | Clinicians assigned to the scribe |
| DELETE | `/api/assignments/:id` | Admin, Super Admin (`assignments`) | Remove an assignment |

### Audit — `/api/audit` (Admin/Super Admin, `audit` module)

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/api/audit/` | Admin, Super Admin | List audit log entries |
| GET | `/api/audit/summary` | Admin, Super Admin | Audit summary/aggregates |
| GET | `/api/audit/export` | Admin, Super Admin | Export audit logs |
| POST | `/api/audit/retention/apply` | Super Admin | Apply audit retention policy |

### Audio — `/api/audio`

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/api/audio/:visitId` | Authenticated (scoped) | Retrieve visit audio via a short-lived presigned S3 URL |

### Admin / System Health — `/api/admin`

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/api/admin/health` | Super Admin | System health: probes DB, Deepgram, Anthropic, S3 (5-min cache) + live metrics |

### Other

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/` | Public | Liveness check (`{ status: 'healthy' }`) |
| `*` | `/api/webhooks/*` | Signed | Deepgram transcription callbacks |
| `*` | `/api/patients/*` | Authenticated | Patient records |
| `*` | `/api/settings/*` | Admin (`settings`) | Encrypted system/AI settings |
| `*` | `/api/support/*` | Authenticated | Support requests |

---

## 8. Database Schema

The authoritative table definitions live in `scripts/bootstrap-local-schema.sql` (and migrations
under `migrations/`). Profile/PHI/forced-password columns on `users` and the extended audit columns
are applied idempotently at startup. The actual column names below differ from some informal
descriptions — these are the real ones.

### `users`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | SERIAL PK | |
| `name` | TEXT | |
| `email` | TEXT UNIQUE | lowercased on login |
| `password` | TEXT | bcrypt hash |
| `role` | VARCHAR(32) | `super_admin` / `admin` / `clinician` / `scribe` / `qps` |
| `specialty`, `phone`, `npi`, `license` | TEXT | clinician profile fields |
| `status` | VARCHAR(24) | default `active` (disable/enable) |
| `avatar_data_url`, `personal_info` | TEXT | profile |
| `admin_modules` | JSONB | granted admin portal modules (`null` = all except `admins`) |
| `rate_per_note` | NUMERIC(10,2) | payroll rate |
| `force_password_change` | BOOLEAN | default `false` |
| `phi_training_acknowledged` | BOOLEAN | default `false` |
| `phi_training_acknowledged_at` | TIMESTAMPTZ | |
| `phi_training_version` | INTEGER | default `1` |
| `created_at` | TIMESTAMPTZ | |

### `patients`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | SERIAL PK | |
| `name` | TEXT | |
| `mrn` | TEXT UNIQUE | medical record number |
| `date_of_birth` | DATE | |
| `created_at` | TIMESTAMPTZ | |

### `visits`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | SERIAL PK | |
| `patient_id` | INTEGER FK → patients | |
| `clinician_id` | INTEGER FK → users | |
| `scribe_id` | INTEGER FK → users | nullable |
| `visit_date` | DATE | |
| `visit_time` | TEXT | |
| `visit_type` | VARCHAR(64) | `Follow-up` / `New Patient` / `Virtual Visit` / `Other` |
| `status` | VARCHAR(32) | default `upcoming`; e.g. `uploaded` |
| `duration_seconds` | INTEGER | |
| `audio_file` | TEXT | S3 path (legacy `/uploads/...` format) |
| `transcription_status` | VARCHAR(32) | `idle` / `processing` / `completed` |
| `created_at` | TIMESTAMPTZ | |

### `notes`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | SERIAL PK | |
| `visit_id` | INTEGER UNIQUE FK → visits | one note per visit |
| `transcription` | TEXT | JSON-encoded transcript segments |
| `ai_draft` | TEXT | Anthropic-generated draft |
| `final_note` | TEXT | scribe/clinician final content |
| `status` | VARCHAR(32) | default `pending`; `draft` / `submitted` / `uploaded` |
| `submitted_by` | INTEGER FK → users | |
| `locked_at`, `locked_by` | TIMESTAMPTZ / INTEGER | approval lock |
| `ehr_uploaded_at`, `ehr_uploaded_by` | TIMESTAMPTZ / INTEGER | EHR upload audit |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

> **Naming note:** the draft fields are `transcription`, `ai_draft`, and `final_note` (there is no
> separate `scribe_draft` column — the scribe edits `final_note`).

### `audit_logs`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | BIGSERIAL PK | |
| `user_id`, `user_name`, `user_role` | INTEGER / TEXT | actor |
| `action` | TEXT | e.g. `SCRIBE_ASSIGNED` |
| `entity_type`, `entity_id` | TEXT | target |
| `details` | TEXT | |
| `ip_address` | VARCHAR(64) | trusted `req.ip`, not spoofable |
| `user_agent`, `request_path` | TEXT / VARCHAR(512) | |
| `status` | VARCHAR(24) | `success` / `warning` / `error` / `failure` / `critical` |
| `module_key`, `action_category` | VARCHAR | admin portal context |
| `event_metadata` | JSONB | default `{}` |
| `created_at` | TIMESTAMPTZ | indexed DESC |

### `grades`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | SERIAL PK | |
| `note_id` | INTEGER UNIQUE FK → notes | one grade per note |
| `qps_id` | INTEGER FK → users | grader |
| `accuracy`, `completeness`, `terminology`, `formatting` | INTEGER | sub-scores |
| `overall_score` | INTEGER | |
| `comment` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

### `scribe_assignments`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | SERIAL PK | |
| `clinician_id` | INTEGER FK → users | |
| `scribe_id` | INTEGER FK → users | |
| `assigned_at` | TIMESTAMPTZ | |
| | | `UNIQUE (clinician_id, scribe_id)` |

---

## 9. Security & Compliance

> See `SECURITY_AND_COMPLIANCE_MANUAL.md`, `HIPAA_COMPLIANCE_SIGN_OFF.md`, `RISK_ASSESSMENT.md`,
> and `BREACH_RESPONSE_PLAN.md` for the full compliance program.

### HIPAA Compliance

- **Workforce training gate** — every user must acknowledge the current PHI awareness training
  revision before a full session is issued; bumping `PHI_TRAINING_VERSION` re-prompts all users.
- **Audit logging** — all PHI-touching and administrative actions are recorded in `audit_logs`
  with actor, IP, user agent, status, and module context. Logs are designed to be append-only and
  retained per the retention policy (target: **7 years**).
- **Encryption** — at rest (S3 AES-256, RDS at-rest) and in transit (TLS via CloudFront/HSTS).

### Authentication

- **JWT** bearer tokens (`expiresIn` default **8h**, `JWT_EXPIRES_IN` configurable). `JWT_SECRET`
  is required at boot and must be ≥16 characters in production.
- **bcrypt** password hashing (`bcryptjs`), enforced password policy, forced password change on
  reset/seed.
- Generic error messages on login to prevent account/role enumeration.

### Authorization

- **Role-based access control** via `restrict(...)` middleware on every route.
- **Admin portal module** gating via `requireAdminPortalModules` for fine-grained admin scope.
- Visit/note access is scoped per role in the controllers (clinicians see their own, scribes see
  assigned, QPS sees review queue).

### Network & Transport Hardening (`src/server.js`)

- **helmet** with a strict Content-Security-Policy, HSTS (1 year, `includeSubDomains`, `preload`).
- Explicit headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` (microphone allowed for recording, camera/geolocation denied).
- **CORS** allow-list (no wildcard `*.vercel.app` regex); extra origins via `CORS_ORIGINS`.
- **Rate limiting**: 100 req/15min global, 20 req/15min on `/api/auth`, 10 failed logins/15min.
- JSON body limits (2 MB default, 15 MB for webhooks) with explicit 400/413 handling.
- `x-powered-by` disabled; trusts exactly 1 proxy hop in production for correct client IPs.

### Audio Privacy

- Audio is never public. It is only retrievable through authenticated `GET /api/audio/:visitId`,
  which issues short-lived (7-day max) presigned S3 URLs.

### Business Associate Agreements (BAAs)

BAAs are in place with sub-processors that may handle PHI: **AWS**, **Deepgram**, and **Anthropic**.

### Breach Response

See `BREACH_RESPONSE_PLAN.md` for the incident detection, containment, notification, and
post-incident procedures.

---

## 10. Configuration & Environment Variables

### Frontend (`.env.production`)

| Variable | Purpose | Example |
| --- | --- | --- |
| `VITE_API_URL` | Backend API base URL | `https://d3t0m4s0ayca85.cloudfront.net/api` |
| `VITE_APP_NAME` | Display app name (optional) | `Anot Health` |

### Backend (Elastic Beanstalk environment)

| Variable | Required | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | **Yes** | JWT signing key (≥16 chars in production) |
| `JWT_EXPIRES_IN` | No | Token lifetime (default `8h`) |
| `DATABASE_URL` | **Yes** | PostgreSQL connection string (RDS) |
| `DEEPGRAM_API_KEY` | **Yes** | Deepgram speech-to-text (or set in Admin → Settings) |
| `ANTHROPIC_API_KEY` | **Yes** | Anthropic Claude (or set in Admin → Settings) |
| `AWS_REGION` | Yes | AWS region (default `ap-southeast-1`) |
| `S3_AUDIO_BUCKET` | Yes | Audio bucket (default `anot-audio-625242092266`) |
| `SETTINGS_ENCRYPTION_KEY` | **Yes** | Encrypts stored system/AI settings (e.g. API keys) |
| `SENTRY_DSN` | No | Sentry error tracking endpoint |
| `CORS_ORIGINS` | No | Comma-separated additional allowed origins |
| `NODE_ENV` | Yes | `production` enables strict limits/headers |
| `PORT` | No | Listen port (default `5000`) |
| `TRUST_PROXY` | No | Proxy hops to trust (default 1 in production) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Local only | Used locally; in EB the instance profile provides credentials |

> **Credentials in production come from the EB instance profile** (AWS provider chain), so static
> access keys are only needed for local development. API keys for Deepgram/Anthropic can be provided
> either as env vars or via the encrypted Admin → Settings store (`SETTINGS_ENCRYPTION_KEY`).

---

## 11. Monitoring & Logging

| Layer | Tool | What it captures |
| --- | --- | --- |
| Application & EB logs | **CloudWatch Logs** | Server logs, audit shipping (`initCloudWatch`), EB platform logs |
| Error tracking | **Sentry** | Unhandled errors and exceptions, **PHI-scrubbed** in `instrument.js` (`beforeSend`) |
| Database audit | `audit_logs` table | Every PHI/admin action with actor, IP, status, module context |
| System health | **Admin → System Health** | `GET /api/admin/health` — live status of DB, Deepgram, Anthropic, S3 + metrics |

### System Health Dashboard

`GET /api/admin/health` (Super Admin) probes the four core dependencies with a 4-second timeout
each, caches the probe results for 5 minutes, and rolls them into an overall status:

- `healthy` — all components OK
- `degraded` — exactly one component failing
- `critical` — two or more components failing

It also returns live DB-backed metrics: `totalUsers`, `activeSessions` (distinct users active in the
last 15 minutes), `errorsLast24h`, and `apiCallsLast24h`.

---

## 12. Disaster Recovery

> Full runbook: `docs/DISASTER_RECOVERY.md`.

| Asset | Protection |
| --- | --- |
| **RDS PostgreSQL** | Automated daily snapshots, **7-day retention**, point-in-time recovery (PITR) |
| **S3 audio** | 11 nines (99.999999999%) durability; no single point of failure; 90-day lifecycle |
| **CloudFront** | Globally distributed CDN; resilient edge caching for the static frontend |
| **Schema** | Idempotent startup migrations recreate required columns on fresh deploys |

**Recovery summary:** restore RDS from snapshot or PITR, redeploy the EB backend (schema is
re-applied at boot), and re-point CloudFront/S3 if needed. Follow `docs/DISASTER_RECOVERY.md` for
the step-by-step procedure and RTO/RPO targets.

---

## 13. Cost Monitoring

> Full guide: `docs/COST_MONITORING.md`.

- **AWS budget:** **$200/month** hard cap, with an alert at 80% ($160). Target run-rate ~$135/month.
- **Service breakdown (targets):** RDS ~$50, EC2/Elastic Beanstalk ~$50, S3 ~$20, CloudFront ~$10,
  other (CloudWatch/SNS) ~$5.
- **Deepgram budget:** **5,000 minutes/month** (~$50), alert at 4,000 min.
- **Anthropic budget:** **10M tokens/month** (~$50), alert at 8M tokens.
- AI spend (Deepgram + Anthropic) is billed by the vendors and **does not** appear in AWS Cost
  Explorer — check their consoles separately.

---

## 14. Known Limitations & Future Work

| Area | Current state | Future |
| --- | --- | --- |
| **EHR integration** | Manual upload only (`POST /api/notes/:id/upload-ehr` records the action) | Automatic EHR push via integration API |
| **Custom domain** | Not yet configured (uses CloudFront default domain) | Custom domain pending TLS certificate |
| **Real-time collaboration** | Not available (one note per visit, sequential review) | Concurrent editing/presence |
| **Mobile** | Web-responsive only | Native mobile app |

---

## 15. Troubleshooting

### Common Issues

| Symptom | Likely cause | Resolution |
| --- | --- | --- |
| Login returns "Invalid email or password" for a valid user | Account disabled (`status != active`) or wrong role | Check `users.status`; generic message hides the reason by design |
| Login asks for password change | `force_password_change = true` | Complete the change flow (`PUT /api/auth/change-password`) |
| Login blocked by training screen | PHI training not acknowledged for current version | Complete `POST /api/auth/acknowledge-phi-training` |
| Transcription stuck on `processing` | Prior run crashed / webhook unreachable | Re-trigger `POST /api/visits/:id/transcribe` — the server resets stuck state to `idle` and retries |
| AI draft shows "unavailable" placeholder | No Anthropic API key configured | Add `ANTHROPIC_API_KEY` or set it in Admin → Settings, then re-run draft generation |
| `409 Note is locked` | Note already locked/approved | A locked note cannot be re-drafted; request edit first |
| CORS error in browser | Origin not in allow-list | Add the origin to `CORS_ORIGINS` |
| `429 Too many requests` | Rate limit hit | Wait 15 minutes; check for retry loops |
| `400 Invalid JSON in request body` | Malformed request body | Fix the client payload |

### How to Check System Health

- **Super Admin → System Health** in the app, or call `GET /api/admin/health`.
- Status `degraded`/`critical` indicates which dependency (DB, Deepgram, Anthropic, S3) is failing
  and why (e.g. "Invalid API key", "Bucket not found", "timed out").

### How to Restart Services

- **Backend:** restart the Elastic Beanstalk environment (`eb restart` or via the EB console). Schema
  migrations re-run safely at boot.
- **Frontend:** re-run `npm run build` and re-upload `dist/` to S3, then invalidate the CloudFront
  cache.

### How to Debug API Errors

1. Reproduce and capture the HTTP status + JSON `error` message.
2. Check **CloudWatch Logs** for the EB environment around the request time.
3. Check **Sentry** for the stack trace (PHI-scrubbed).
4. Cross-reference `audit_logs` for the actor/action context.

### How to Access Production Logs

- **CloudWatch Logs** (AWS Console → CloudWatch → Log groups) for application/EB logs.
- `eb logs` from the EB CLI for the environment's recent platform/app logs.
- **Sentry** dashboard for error events.

---

## 16. Useful Links & References

| Resource | URL |
| --- | --- |
| GitHub | https://github.com/1993ALINE/anot-health |
| Frontend repo path | `anot-frontend-main` |
| Backend repo path | `anot-backend-main` |
| AWS Console | https://console.aws.amazon.com |
| Deepgram Console | https://console.deepgram.com |
| Anthropic Console | https://console.anthropic.com |
| Admin Panel | https://app.anot.health/admin |
| System Health | https://app.anot.health/admin/health |

**Companion docs:** `docs/COST_MONITORING.md`, `docs/DISASTER_RECOVERY.md`,
`docs/CLINICIAN_ONBOARDING.md`, `docs/ADMIN_ONBOARDING.md`, `SECURITY_AND_COMPLIANCE_MANUAL.md`,
`HIPAA_COMPLIANCE_SIGN_OFF.md`, `BREACH_RESPONSE_PLAN.md`, `RISK_ASSESSMENT.md`,
`PHI_TRAINING_ACKNOWLEDGMENT.md`, `PRIVACY_POLICY.md`, `TERMS_OF_SERVICE.md`.

---

## 17. Deployment Checklists

### Pre-Deployment Checklist (before v37, v38, …)

- [ ] All changes merged and CI green on the target branch.
- [ ] Version bumped and release notes drafted.
- [ ] Required env vars present in the EB environment (`JWT_SECRET`, `DATABASE_URL`,
      `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_REGION`, `S3_AUDIO_BUCKET`,
      `SETTINGS_ENCRYPTION_KEY`).
- [ ] `JWT_SECRET` is ≥16 chars and `NODE_ENV=production`.
- [ ] Database migrations reviewed (startup schema is idempotent, but verify new migrations).
- [ ] Frontend `.env.production` `VITE_API_URL` points to the correct API base.
- [ ] Recent RDS snapshot confirmed (rollback safety).

### Deployment Procedure (step-by-step)

1. **Backend:** build the deployable bundle and deploy to Elastic Beanstalk (`eb deploy`). Schema
   migrations apply automatically at startup before traffic is accepted.
2. **Frontend:** `npm run build`, upload `dist/` to the S3 static bucket.
3. **CloudFront:** create an invalidation (`/*`) so users get the new assets.
4. Confirm the backend liveness check (`GET /`) returns `{ status: 'healthy' }`.

### Post-Deployment Verification

- [ ] `GET /` returns healthy and reports the expected version.
- [ ] `GET /api/admin/health` (Super Admin) shows all components `ok` (status `healthy`).
- [ ] Log in as each role and smoke-test the core workflow (record → transcribe → review → approve).
- [ ] Spot-check CloudWatch and Sentry for new errors.
- [ ] Verify audit entries are being written for test actions.

### Rollback Procedure (if needed)

1. **Backend:** redeploy the previous known-good application version in Elastic Beanstalk.
2. **Frontend:** re-upload the previous `dist/` build to S3 and invalidate CloudFront.
3. **Database:** if a migration caused the issue, restore from the pre-deployment RDS snapshot or use
   PITR (see `docs/DISASTER_RECOVERY.md`). Prefer forward-fixes over destructive restores.
4. Re-run the post-deployment verification checklist after rollback.

---

## 18. Contact & Support

| Role | Contact |
| --- | --- |
| Technical lead | Atiqur Rahman — `admin@anot.health` |
| Support | `support@anot.health` |
| Privacy | `privacy@anot.health` |
| Emergency | +8801521434819 |
