# anot — full stack workspace

## What this project is

**Anot** is a **clinical documentation** platform: care teams capture **visit audio**, produce **structured notes** (with optional **AI** via Groq), and move work through **scribe → QPS review** flows. **Clinicians** (physicians) manage **patients and visits**; **admins** handle **users, assignments, payroll, and audit**.

It is built as **two packages** in one workspace—**not** two unrelated apps:

| Part | Stack | Role |
|------|--------|------|
| **Backend** (`anot-backend-main/anot-backend-main`) | Node, Express, PostgreSQL, JWT | REST API, file/audio, AI pipeline |
| **Frontend** (`anot-frontend-main/anot-frontend-main`) | React 19, Vite, React Router | Role-based SPA (clinician, scribe, QPS, admin, super admin) |

**Why two folders?** The code is often split across two Git repos (API vs UI). Locally they are **merged operationally**: same product, shared API contract (`/api/...`), run together against one dev database.

**Roadmap (incremental):** Improve the **clinician (“doctor”)** experience in **small steps**—layout, typography, visit flows—without breaking scribe/QPS/admin.

## Documentation (deploy)

| Guide | Path |
|-------|------|
| **Localhost setup** | [`deploy/LOCALHOST_SETUP.md`](deploy/LOCALHOST_SETUP.md) |
| **Amazon AWS deployment** | [`deploy/AWS_DEPLOYMENT.md`](deploy/AWS_DEPLOYMENT.md) |
| **cPanel deployment** | [`deploy/CPANEL_DEPLOYMENT.md`](deploy/CPANEL_DEPLOYMENT.md) |
| **Index** | [`deploy/README.md`](deploy/README.md) |

## Layout on disk

GitHub zips often unpack with a nested folder. Your workspace uses:

```text
anot/                                    ← repo root (this README)
  .env                                   ← optional copy of DATABASE_URL (gitignored)
  anot-backend-main/
    anot-backend-main/                   ← Node API: npm install / npm run dev
      .env                               ← DATABASE_URL, JWT_SECRET (gitignored)
      src/server.js
  anot-frontend-main/
    anot-frontend-main/                  ← Vite app: npm install / npm run dev
      .env.local                         ← VITE_API_URL (gitignored)
      src/
```

## Local development

From the **repo root** (`anot`), install everything once, then start **API + web** together:

```powershell
Set-Location "C:\Users\Jp Asher\Documents\GitHub\anot"
npm install
npm run install:all
npm run dev
```

- **API:** `http://127.0.0.1:5000/` (health JSON)  
- **App:** URL printed by Vite (often `http://localhost:5173`) — sign in at **`/login`**. **`/`** redirects by session/role.

On localhost the client uses **`http://127.0.0.1:5000/api`** by default — see `anot-frontend-main/anot-frontend-main/src/services/api.js`. Override with **`VITE_API_URL`** / **`VITE_USE_LOCAL_API`** in `.env.local` — [deploy/LOCALHOST_SETUP.md](deploy/LOCALHOST_SETUP.md).

**“Failed to fetch” / “Cannot reach the API”:** [deploy/LOCALHOST_SETUP.md#12-troubleshooting-localhost](deploy/LOCALHOST_SETUP.md#12-troubleshooting-localhost). Quick checks: API still running; open `http://127.0.0.1:5000/`; use the Vite URL from the terminal if port 5173 is busy.

**Run services separately** (two terminals) if you prefer:

```powershell
# Terminal 1
Set-Location ".\anot-backend-main\anot-backend-main"
npm install
npm run dev

# Terminal 2
Set-Location ".\anot-frontend-main\anot-frontend-main"
npm install
npm run dev
```

### Dev test accounts (disposable DB only)

With **`DATABASE_URL`** in **`anot-backend-main\anot-backend-main\.env`** pointing at your **dev** database:

```powershell
# From repo root
npm run seed:dev

# Or from the backend folder
Set-Location ".\anot-backend-main\anot-backend-main"
npm run seed:dev
```

That creates or updates the accounts below (and prints the same details in the terminal). **Never run this against production.** Manual run: `ALLOW_DEV_SEED=true node scripts/seed-dev-users.js` from the backend folder.

**Seeded roles** (`scripts/seed-dev-users.js` → `users.role` in the database):

| Email | Password | Role (DB) | Portal after login |
|-------|----------|-----------|-------------------|
| `clinician@dev.anot.local` | `DevClinician!2026` | `clinician` | Doctor/clinician workspace (`/clinician`) |
| `scribe@dev.anot.local` | `DevScribe!2026` | `scribe` | Scribe (`/scribe`) |
| `qps@dev.anot.local` | `DevQps!2026` | `qps` | QPS (`/qps`) |
| `admin@dev.anot.local` | `DevAdmin!2026` | `admin` | Admin (`/admin`) |
| `superadmin@dev.anot.local` | `DevSuperAdmin!2026` | `super_admin` | Super Admin (`/admin`) |

Sign-in is always at **`/login`**; the app routes by **`role`** from the server — no role choice on the login page.

## Environment

| Location | Purpose |
|----------|---------|
| `anot-backend-main/anot-backend-main/.env` | `DATABASE_URL`, `JWT_SECRET`, optional `GROQ_API_KEY`, `PORT` |
| `anot-frontend-main/anot-frontend-main/.env.local` | Optional. On **localhost** / **127.0.0.1**, the app uses **`http://127.0.0.1:5000/api`** by default unless **`VITE_USE_LOCAL_API=false`**. See [deploy/LOCALHOST_SETUP.md](deploy/LOCALHOST_SETUP.md). |

Use your **Neon dev** database only for local work; production is separate.

## Upstream repos

- Frontend: `https://github.com/1993ALINE/anot-frontend.git`
- Backend: `https://github.com/1993ALINE/anot-backend.git`

## Security

Do not commit `.env` / `.env.local`. Rotate any database password that has been exposed outside your team.
