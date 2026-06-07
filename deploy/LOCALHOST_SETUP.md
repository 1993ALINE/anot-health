# Anot — Localhost setup (complete guide)

Run the **Node API** and **Vite React app** on your computer for development and testing.

**Security:** Never commit `.env`, `.env.local`, or real database passwords. Do not run dev seed scripts against production databases.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)  
2. [Repository layout](#2-repository-layout)  
3. [Install dependencies](#3-install-dependencies)  
4. [PostgreSQL](#4-postgresql)  
5. [Backend configuration (`.env`)](#5-backend-configuration-env)  
6. [Start the stack](#6-start-the-stack)  
7. [Verify URLs](#7-verify-urls)  
8. [Frontend environment (optional)](#8-frontend-environment-optional)  
9. [SQL migrations](#9-sql-migrations)  
10. [Dev seed users](#10-dev-seed-users)  
11. [Production build preview](#11-production-build-preview)  
12. [Troubleshooting (localhost)](#12-troubleshooting-localhost)

---

## 1) Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js** | 18+; **20 LTS** recommended |
| **npm** | Included with Node |
| **PostgreSQL** | Local install, Docker, or a hosted dev DB (Neon, etc.) |

Optional: **Git** (to clone/pull the repo).

---

## 2) Repository layout

GitHub zips often add an extra nested folder. In this repo the **real** `package.json` files are here:

```text
anot/                                      ← repository root
  package.json                             ← workspace: npm run dev, install:all, seed:dev
  anot-backend-main/
    anot-backend-main/                     ← BACKEND (Node API)
      package.json
      .env                                 ← YOU CREATE (gitignored)
      src/server.js
      migrations/
      scripts/seed-dev-users.js
  anot-frontend-main/
    anot-frontend-main/                    ← FRONTEND (Vite)
      package.json
      .env.local                           ← optional (gitignored)
      src/
```

All commands below assume you know whether you are at **repo root** `anot/` or inside an **inner** folder.

---

## 3) Install dependencies

### Option A — one shot from repo root (recommended)

**Windows (PowerShell):**

```powershell
cd "C:\Path\To\anot"
npm install
npm run install:all
```

`npm install` installs **`concurrently`** at the root.  
`npm run install:all` runs `npm install` inside **both** inner packages.

### Option B — each package manually

```powershell
cd anot-backend-main\anot-backend-main
npm install

cd ..\..\anot-frontend-main\anot-frontend-main
npm install
```

---

## 4) PostgreSQL

Create a database and a user with rights on that database. Example connection string for **`.env`**:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5432/anot_dev
```

The API **exits on startup** if it cannot connect — fix DB credentials before starting the server.

### Automated local PostgreSQL (Windows)

If **Neon** credentials fail (`password authentication failed for user 'neondb_owner'`) but **PostgreSQL 18** is installed locally, run once from an **elevated** PowerShell if needed:

```powershell
cd anot-backend-main\anot-backend-main
.\scripts\setup-local-postgres.ps1
```

That script creates database **`anot_dev`**, user **`anot_dev`**, applies schema + migrations, seeds dev users, and writes **`.env`** using **`DB_*`** (no SSL — required for local Postgres).

**Local DB credentials (dev only):**

| Item | Value |
|------|--------|
| Host | `127.0.0.1` |
| Port | `5432` |
| Database | `anot_dev` |
| User | `anot_dev` |
| Password | `anot_local_dev_2026` |

After setup, **restart** `npm run dev` so the API reloads `.env`.

---

## 5) Backend configuration (`.env`)

**Path:** `anot-backend-main/anot-backend-main/.env`

### Required

| Variable | Example | Notes |
|----------|---------|--------|
| **`JWT_SECRET`** | (output of command below) | **Required.** Server exits if missing. |

Generate a secret (PowerShell has no `openssl` by default; use **Git Bash**, WSL, or install OpenSSH/OpenSSL tools):

```bash
openssl rand -hex 32
```

### Database (choose one style)

**Style A — `DATABASE_URL`** (cloud DBs such as Neon)

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
```

Database SSL always verifies the server certificate (see `src/config/db.js`) — use a provider whose certificate chain Node can validate.

**Style A — local Postgres without SSL:** prefer **Style B** below. Using `DATABASE_URL` against local Postgres often causes **“The server does not support SSL connections”**.

**Style B — discrete variables**

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=anot_dev
DB_USER=postgres
DB_PASSWORD=YOUR_PASSWORD
```

Add `DB_SSL=true` if the server requires SSL.

### Optional server variables

| Variable | Default | Notes |
|----------|---------|--------|
| `PORT` | `5000` | API port |
| `NODE_ENV` | `development` | |
| `BIND_HOST` | `0.0.0.0` | Listen address |
| `TRUST_PROXY` | `0` / unset locally | Set when behind a reverse proxy in production |

### Optional features

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | AI draft generation (Anthropic Claude) if used in your deployment |
| `CORS_ORIGINS` | Usually **omit** locally — `server.js` allows localhost / `127.0.0.1` on various ports in development |

### Minimal example `.env` (local)

```env
JWT_SECRET=your-long-random-string-at-least-16-chars
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5432/anot_dev
```

---

## 6) Start the stack

### One terminal (API + UI)

From **repo root**:

```powershell
cd "C:\Path\To\anot"
npm run dev
```

You should see **`[api]`** and **`[web]`** streams:

- API: `node --watch src/server.js`
- Web: `vite`

### Two terminals (if you prefer)

**Terminal 1 — API**

```powershell
cd anot-backend-main\anot-backend-main
npm run dev
```

**Terminal 2 — UI**

```powershell
cd anot-frontend-main\anot-frontend-main
npm run dev
```

Start the **API first** so the browser does not call a dead server on first paint.

### Root `package.json` shortcuts

| Command | Action |
|---------|--------|
| `npm run dev` | Backend + frontend together |
| `npm run dev:backend` | API only |
| `npm run dev:frontend` | UI only |
| `npm run seed:dev` | Dev users seed (backend prefix) |

Equivalent without root scripts:

```powershell
npm run dev --prefix anot-backend-main/anot-backend-main
npm run dev --prefix anot-frontend-main/anot-frontend-main
```

---

## 7) Verify URLs

| Service | URL | Expected |
|---------|-----|----------|
| **API health** | `http://127.0.0.1:5000/` | JSON: `Anot API is running` |
| **UI** | `http://localhost:5173/` (or next port if busy) | Vite prints **Local:** in the terminal |

**PowerShell health check:**

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:5000/" -UseBasicParsing
```

Sign in at **`/login`** (e.g. `http://localhost:5173/login`). Route **`/`** redirects using `localStorage` session and role.

### How the UI chooses the API

File: `anot-frontend-main/anot-frontend-main/src/services/api.js`

- On **`localhost` or `127.0.0.1`**, the app uses **`http://127.0.0.1:5000/api`** by default (reduces Windows IPv6 **`::1`** vs IPv4 issues).
- To use a **remote** API while on localhost: create **`.env.local`** with:

```env
VITE_USE_LOCAL_API=false
VITE_API_URL=https://your-remote-host/api
```

---

## 8) Frontend environment (optional)

| File | Use |
|------|-----|
| `.env.local` | Overrides; not committed by convention |

See [Vite env documentation](https://vite.dev/guide/env-and-mode.html). Only **`VITE_*`** variables are exposed to the browser.

---

## 9) SQL migrations

Migrations live in:

```text
anot-backend-main/anot-backend-main/migrations/
```

Apply with **`psql`** (repeat for each file in chronological order):

```bash
psql "postgresql://USER:PASS@HOST:5432/DBNAME" -f anot-backend-main/anot-backend-main/migrations/20260210_visits_visit_type_add_other.sql
```

**Windows (from repo root), example:**

```powershell
psql $env:DATABASE_URL -f anot-backend-main\anot-backend-main\migrations\20260210_visits_visit_type_add_other.sql
```

**Package helper** (check `package.json` for exact script name):

```powershell
cd anot-backend-main\anot-backend-main
npm run migrate:visit-type-other
```

---

## 10) Dev seed users

**Only** on disposable development databases. Script: `scripts/seed-dev-users.js` — refuses to run without **`ALLOW_DEV_SEED=true`** or **`--force-dev-seed`**.

**From repo root:**

```powershell
npm run seed:dev
```

**From backend folder:**

```powershell
cd anot-backend-main\anot-backend-main
npm run seed:dev
```

**Manual:**

```powershell
cd anot-backend-main\anot-backend-main
ALLOW_DEV_SEED=true node scripts/seed-dev-users.js
```

or:

```powershell
node scripts/seed-dev-users.js --force-dev-seed
```

### Seeded accounts (from the script)

| Email | Password | Role | After login |
|-------|----------|------|-------------|
| `clinician@dev.anot.local` | `DevClinician!2026` | `clinician` | `/clinician` |
| `scribe@dev.anot.local` | `DevScribe!2026` | `scribe` | `/scribe` |
| `qps@dev.anot.local` | `DevQps!2026` | `qps` | `/qps` |
| `admin@dev.anot.local` | `DevAdmin!2026` | `admin` | `/admin` |
| `superadmin@dev.anot.local` | `DevSuperAdmin!2026` | `super_admin` | `/admin` |

---

## 11) Production build preview

```powershell
cd anot-frontend-main\anot-frontend-main
npm run build
npm run preview
```

If the preview calls the wrong API, read **`src/services/api.js`** and adjust **`.env.production`** / **`VITE_USE_LOCAL_API`**.

---

## 12) Troubleshooting (localhost)

| Symptom | What to do |
|---------|------------|
| **“Cannot reach the API” / “Failed to fetch”** | Ensure **`npm run dev`** is running and the **`[api]`** stream shows `Anot server running on http://127.0.0.1:5000`. Hit `http://127.0.0.1:5000/` in the browser. |
| **Backend exits immediately** | Missing **`JWT_SECRET`** or bad **`DATABASE_URL`** — read the API terminal. |
| **Port 5000 in use (Windows)** | `netstat -ano \| findstr :5000` — stop the other process or set **`PORT=5001`** in backend `.env` and set **`VITE_API_URL=http://127.0.0.1:5001/api`** in frontend `.env.local`. |
| **Error before sign-in** | Old **`token`** in `localStorage` triggers **`/api/auth/me`**; failing API looks like a login failure. Clear site data or use a private window. |
| **CORS in production** | Not typical on pure localhost; for deployed APIs set **`CORS_ORIGINS`** — see **AWS** or **cPanel** guides in this folder. |
| **Scribe: Transcription stuck on “Processing”** | A prior run may have left `transcription_status=processing`. Click **Transcribe audio** again (server now clears stuck jobs) or **Refresh**. Clear a fake Deepgram webhook URL in Admin → Settings if it points to `localhost`. |
| **Scribe: transcript OK but no AI draft** | Set **`ANTHROPIC_API_KEY=...`** in backend `.env` (or the Anthropic key in Admin → Settings) and restart `npm run dev`. |
| **`.webm` audio / corrupt audio errors** | Install **ffmpeg** on the server PATH, or enable FFmpeg preprocessing in Admin → Settings. |

---

## Quick reference (copy-paste)

```powershell
cd "C:\Path\To\anot"
npm install
npm run install:all
# Create anot-backend-main\anot-backend-main\.env with JWT_SECRET + DATABASE_URL
npm run dev
```

Product overview: **`../README.md`**.
