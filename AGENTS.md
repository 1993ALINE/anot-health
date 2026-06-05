# AGENTS.md

## Cursor Cloud specific instructions

### Product

**Anot** is a clinical documentation platform: Node/Express API + Vite/React SPA in a single workspace. See `README.md` and `deploy/LOCALHOST_SETUP.md` for full setup.

### Services (local dev)

| Service | Port | Start |
|---------|------|--------|
| PostgreSQL 16 | 5432 | `sudo pg_ctlcluster 16 main start` (if not running) |
| API | 5000 | `npm run dev:backend` or `npm run dev` from repo root |
| Web (Vite) | 5173 | `npm run dev:frontend` or `npm run dev` from repo root |

Run **API before or with** the UI so `/api/auth/me` does not fail on first load.

### Backend `.env` (required, gitignored)

Path: `anot-backend-main/anot-backend-main/.env`. Copy from `.env.example`. Minimum:

- `JWT_SECRET` (server exits without it)
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (prefer `DB_*` over `DATABASE_URL` for local Postgres without SSL)

**Cloud VM local DB** (after one-time Postgres setup): database `anot_dev`, user `anot_dev`, password `anot_local_dev_2026`. Apply schema once:

```bash
export PGPASSWORD=anot_local_dev_2026
BACKEND=anot-backend-main/anot-backend-main
psql -h 127.0.0.1 -U anot_dev -d anot_dev -f "$BACKEND/scripts/bootstrap-local-schema.sql"
for f in "$BACKEND"/migrations/*.sql; do psql -h 127.0.0.1 -U anot_dev -d anot_dev -f "$f"; done
npm run seed:dev   # from repo root; dev DB only
```

### Common commands (repo root)

| Task | Command |
|------|---------|
| Install all deps | `npm install && npm run install:all` |
| Dev (API + UI) | `npm run dev` |
| Seed dev users | `npm run seed:dev` |
| Frontend lint | `npm run lint --prefix anot-frontend-main/anot-frontend-main` |
| Frontend build | `npm run build --prefix anot-frontend-main/anot-frontend-main` |

Backend has no `lint` or `test` script in `package.json`.

### Health checks

- API: `curl http://127.0.0.1:5000/` → JSON with `"status":"healthy"`
- UI: `http://localhost:5173/login` (Vite may bind to `localhost` only; use that hostname in the browser)

### Dev logins (after `npm run seed:dev`)

| Email | Password |
|-------|----------|
| `clinician@dev.anot.local` | `DevClinician!2026` |
| `scribe@dev.anot.local` | `DevScribe!2026` |
| `admin@dev.anot.local` | `DevAdmin!2026` |

Sign-in at `/login`; routing is by server `role`.

### Gotchas

- **Lint:** `npm run lint` in the frontend reports many pre-existing ESLint issues; failures are not necessarily from your change.
- **Frontend curl:** `127.0.0.1:5173` may fail while `localhost:5173` works (Vite host binding).
- **PostgreSQL:** On this VM image, Postgres is installed via apt but may need `pg_ctlcluster 16 main start` after reboot.
- **Optional:** `GROQ_API_KEY`, Deepgram (Admin → Settings), and `ffmpeg` on PATH are only needed for AI/transcription features.
