# Anot — Google Cloud Deployment Guide

Deploy the Anot **backend** to **Cloud Run** (containerized Node/Express API on
Cloud SQL for PostgreSQL, with audio stored in Cloud Storage) and the **frontend**
to **Firebase Hosting**.

Everything is scripted. Once billing is active you can run one script and be live
in ~30 minutes (most of the time is Cloud SQL provisioning).

---

## Architecture

```
              ┌────────────────────────┐
  Browser ──▶ │ Firebase Hosting (SPA) │  static Vite/React build (dist/)
              └───────────┬────────────┘
                          │ HTTPS (VITE_API_URL → /api)
                          ▼
              ┌────────────────────────┐      Cloud SQL Auth (unix socket)
              │   Cloud Run (backend)  │ ───────────────────────────────▶  Cloud SQL
              │   Node 20 + ffmpeg     │                                   PostgreSQL
              │   listens on :8080     │ ── GCS volume mount ──▶ Cloud Storage bucket
              └────────────────────────┘    /app/src/uploads        (audio files)
```

Why these choices:
- **Cloud Run** scales to zero, handles TLS, and runs the existing container unchanged.
- **Cloud SQL** is reached through the built-in Cloud SQL connection (a unix socket
  at `/cloudsql/<conn>`), so `DB_HOST` is that socket path and no public IP/SSL config
  is needed. `src/config/db.js` already supports discrete `DB_*` vars.
- **Cloud Storage volume mount**: Cloud Run's local disk is ephemeral and per-instance.
  The bucket is mounted at `/app/src/uploads` (where `multer` writes audio), so uploads
  persist and are shared across instances **with no code changes**.

---

## Files in this folder

| File | Purpose |
|------|---------|
| `setup.sh` | One-shot provisioning + deploy (APIs, SQL, bucket, secrets, Cloud Run, Firebase). |
| `cloudbuild.yaml` | Build the backend image and deploy to Cloud Run (used by `setup.sh` and for CI). |
| `env.production.example` | Every production env var, with notes on which are secrets. |
| `README.md` | This guide. |

Backend container files live with the backend:
`anot-backend-main/Dockerfile` and `.dockerignore`.

---

## Prerequisites

- A Google Cloud project with **billing enabled**.
- One of:
  - **Cloud Shell** (recommended — `gcloud`, `firebase`, `openssl`, `node` are preinstalled), or
  - A local machine with [`gcloud`](https://cloud.google.com/sdk/docs/install),
    [`firebase-tools`](https://firebase.google.com/docs/cli) (`npm i -g firebase-tools`),
    `node` 20+, and `openssl`.
- Your `ANTHROPIC_API_KEY` (and optionally `DEEPGRAM_WEBHOOK_SECRET`).

> The setup script is **bash**. On Windows, run it from **Cloud Shell**, **WSL**, or **Git Bash**.

---

## Fast path (≈30 minutes)

From the **repository root**:

```bash
# 1. Authenticate and select your project
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
firebase login

# 2. Provide your provider key(s) so they go straight into Secret Manager
export ANTHROPIC_API_KEY="sk-ant-..."
# export DEEPGRAM_WEBHOOK_SECRET="..."   # optional

# 3. Run the whole thing
chmod +x deploy/google-cloud/setup.sh
PROJECT_ID=YOUR_PROJECT_ID REGION=us-central1 ./deploy/google-cloud/setup.sh
```

When it finishes it prints the **backend URL** and **frontend URL**. The only
manual step is applying database migrations (step 7 below) — uncomment that block
in `setup.sh` or run it once by hand.

---

## What `setup.sh` does (step by step)

### 1. Enable APIs
Cloud Run, Cloud Build, Cloud SQL Admin, Cloud Storage, Artifact Registry,
Secret Manager, Firebase Hosting.

### 2. Artifact Registry
Creates a Docker repo (`anot`) in your region to hold the backend image.

### 3. Cloud SQL (PostgreSQL)
Creates instance `anot-postgres` (`POSTGRES_16`, tier `db-custom-1-3840`),
the `anot` database, and the `anot_app` user. The generated DB password is stored
**only** in Secret Manager (`anot-db-password`).

### 4. Cloud Storage bucket
Creates `gs://<project-id>-anot-audio` (uniform access, public access prevented)
for audio uploads. It's mounted into Cloud Run at `/app/src/uploads`.

### 5. Secrets (Secret Manager)
Creates/uses: `anot-jwt-secret`, `anot-db-password`,
`anot-settings-encryption-key`, `anot-anthropic-key`, `anot-deepgram-webhook-secret`.
JWT secret and encryption key are auto-generated with `openssl` if absent.

### 6. IAM
Grants the Cloud Run runtime service account `roles/secretmanager.secretAccessor`,
`roles/cloudsql.client`, and `roles/storage.objectAdmin` (on the bucket).

### 7. Database migrations  ⚠️ run once
SQL migrations live in `anot-backend-main/migrations/*.sql`.
Apply them in filename order. Easiest via the Cloud SQL connect helper:

```bash
cd anot-backend-main
for f in $(ls migrations/*.sql | sort); do
  echo "Applying $f"
  gcloud sql connect anot-postgres --user=anot_app --database=anot < "$f"
done
```

(There's a commented-out block doing exactly this in `setup.sh`.)

### 8. Deploy backend to Cloud Run
Runs Cloud Build (`cloudbuild.yaml`) to build the image and deploy with:
- `--add-cloudsql-instances` for the SQL socket,
- a Cloud Storage volume mounted at `/app/src/uploads`,
- env vars (`NODE_ENV`, `DB_HOST` socket, `DB_NAME`, `DB_USER`, `CORS_ORIGINS`),
- secrets injected via `--set-secrets`.

### 9. Deploy frontend to Firebase Hosting
Builds the Vite app with `VITE_API_URL=<backend-url>/api`, generates a minimal
SPA `firebase.json` if missing, and runs `firebase deploy --only hosting`. CORS on
the backend is then locked to the Firebase origins.

---

## Manual / CI deploys

**Backend only** (e.g. from CI, after the first full setup):

```bash
gcloud builds submit --config deploy/google-cloud/cloudbuild.yaml \
  --substitutions=_REGION=us-central1,_SERVICE=anot-backend,_AR_REPO=anot,\
_SQL_INSTANCE=anot-postgres,_DB_NAME=anot,_DB_USER=anot_app,\
_BUCKET=$PROJECT_ID-anot-audio,\
_CORS_ORIGINS=https://YOUR_SITE.web.app,https://YOUR_SITE.firebaseapp.com .
```

**Frontend only:**

```bash
cd anot-frontend-main
VITE_API_URL="https://<cloud-run-url>/api" npm run build
firebase deploy --only hosting --project YOUR_PROJECT_ID
```

---

## Configuration reference

All variables and which are secrets are documented in
[`env.production.example`](./env.production.example). Override `setup.sh` defaults
by exporting them first, e.g.:

```bash
REGION=europe-west1 SQL_TIER=db-custom-2-7680 FIREBASE_SITE=anot-prod \
  ./deploy/google-cloud/setup.sh
```

Update a secret later (Cloud Run picks up `:latest` on the next deploy):

```bash
printf 'sk-ant-NEWKEY' | gcloud secrets versions add anot-anthropic-key --data-file=-
gcloud run services update anot-backend --region=us-central1   # redeploy to pick it up
```

---

## Verify

```bash
# Backend health check (should return the "Anot API is running" JSON)
curl -s "$(gcloud run services describe anot-backend --region=us-central1 \
  --format='value(status.url)')/"

# Tail backend logs
gcloud run services logs read anot-backend --region=us-central1 --limit=50
```

Open `https://<your-site>.web.app` and log in.

---

## Cost notes

- **Cloud Run** scales to zero (`--min-instances=0`) — you pay per request.
- **Cloud SQL** runs continuously and is the main fixed cost. For demos, stop the
  instance when idle: `gcloud sql instances patch anot-postgres --activation-policy=NEVER`
  (start again with `--activation-policy=ALWAYS`).
- **Cloud Storage** is billed by stored audio volume + egress.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `JWT_SECRET is required` / container crash-loops | Ensure `anot-jwt-secret` exists and IAM `secretAccessor` is granted; redeploy. |
| `Database connection failed at startup` | Check `DB_HOST=/cloudsql/<conn>` matches the instance connection name and `--add-cloudsql-instances` is set. |
| Audio uploads disappear | Confirm the GCS volume is mounted at `/app/src/uploads` (gen2 execution env). |
| CORS errors in browser | `CORS_ORIGINS` must include your exact Firebase Hosting origin(s). |
| 403 on image push | Run `gcloud auth configure-docker <region>-docker.pkg.dev` (Cloud Build handles this automatically). |
