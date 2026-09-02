#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Anot — Google Cloud one-shot setup
#
# Provisions everything needed to run Anot on Google Cloud and deploys both apps:
#   1. Enables required APIs (Cloud Run, Cloud Build, Cloud SQL, Storage, etc.)
#   2. Creates an Artifact Registry repo
#   3. Creates a Cloud SQL PostgreSQL instance + database + app user
#   4. Creates a Cloud Storage bucket for audio files
#   5. Stores secrets in Secret Manager and grants access
#   6. Builds + deploys the backend to Cloud Run
#   7. Builds + deploys the frontend to Firebase Hosting
#
# Run from the repository ROOT in Cloud Shell (recommended) or any machine with
# gcloud + firebase CLIs and Docker-less Cloud Build:
#   chmod +x deploy/google-cloud/setup.sh
#   ./deploy/google-cloud/setup.sh
#
# Re-running is safe: existing resources are detected and skipped.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration (override via environment before running) ──────────────────
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-anot}"
SERVICE="${SERVICE:-anot-backend}"

SQL_INSTANCE="${SQL_INSTANCE:-anot-postgres}"
SQL_TIER="${SQL_TIER:-db-custom-1-3840}"   # 1 vCPU / 3.75 GB; smallest production-ish tier
DB_VERSION="${DB_VERSION:-POSTGRES_16}"
DB_NAME="${DB_NAME:-anot}"
DB_USER="${DB_USER:-anot_app}"

BUCKET="${BUCKET:-${PROJECT_ID}-anot-audio}"

# Frontend (Firebase Hosting)
FIREBASE_SITE="${FIREBASE_SITE:-$PROJECT_ID}"
FRONTEND_DIR="anot-frontend-main"
BACKEND_DIR="anot-backend-main"

# Optional provider keys — read from env if present, else left blank/prompted.
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
DEEPGRAM_WEBHOOK_SECRET="${DEEPGRAM_WEBHOOK_SECRET:-}"

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$PROJECT_ID" ] || die "PROJECT_ID is not set and no gcloud default project found. Run: gcloud config set project <id>"
command -v gcloud >/dev/null || die "gcloud CLI not found."

gcloud config set project "$PROJECT_ID" >/dev/null
log "Project: $PROJECT_ID | Region: $REGION"

# Ensure a secret exists with the given value (creates or adds a new version).
ensure_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=- >/dev/null
  fi
}

# ── 1. Enable APIs ───────────────────────────────────────────────────────────
log "Enabling required APIs (this can take a minute)..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  firebasehosting.googleapis.com

# ── 2. Artifact Registry ─────────────────────────────────────────────────────
log "Ensuring Artifact Registry repo '$AR_REPO'..."
if ! gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Anot container images"
else
  echo "  already exists."
fi

# ── 3. Cloud SQL (PostgreSQL) ────────────────────────────────────────────────
log "Ensuring Cloud SQL instance '$SQL_INSTANCE'..."
if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version="$DB_VERSION" \
    --tier="$SQL_TIER" \
    --region="$REGION" \
    --storage-auto-increase \
    --availability-type=zonal
else
  echo "  instance already exists."
fi

SQL_CONN="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"
log "Cloud SQL connection name: $SQL_CONN"

# Generate/reuse DB password (kept only in Secret Manager).
if gcloud secrets describe anot-db-password >/dev/null 2>&1; then
  DB_PASSWORD="$(gcloud secrets versions access latest --secret=anot-db-password)"
  echo "  reusing existing DB password from Secret Manager."
else
  DB_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
fi

log "Ensuring database '$DB_NAME' and user '$DB_USER'..."
gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1 || echo "  database already exists."
if gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
  gcloud sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD" >/dev/null
  echo "  user exists; password reset."
else
  gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD" >/dev/null
fi

# ── 4. Cloud Storage bucket (audio files) ────────────────────────────────────
log "Ensuring Cloud Storage bucket 'gs://$BUCKET'..."
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --public-access-prevention
else
  echo "  bucket already exists."
fi

# ── 5. Secrets ───────────────────────────────────────────────────────────────
log "Writing secrets to Secret Manager..."
ensure_secret anot-db-password "$DB_PASSWORD"

if gcloud secrets describe anot-jwt-secret >/dev/null 2>&1; then
  echo "  anot-jwt-secret exists; keeping current value."
else
  ensure_secret anot-jwt-secret "$(openssl rand -base64 48)"
fi

if gcloud secrets describe anot-settings-encryption-key >/dev/null 2>&1; then
  echo "  anot-settings-encryption-key exists; keeping current value."
else
  ensure_secret anot-settings-encryption-key "$(openssl rand -hex 32)"
fi

# Provider keys: create placeholders if not provided so --set-secrets won't fail.
ensure_secret anot-anthropic-key "${ANTHROPIC_API_KEY:-REPLACE_ME}"
ensure_secret anot-deepgram-webhook-secret "${DEEPGRAM_WEBHOOK_SECRET:-REPLACE_ME}"
[ -n "$ANTHROPIC_API_KEY" ] || warn "ANTHROPIC_API_KEY not provided — placeholder stored. Update with: gcloud secrets versions add anot-anthropic-key --data-file=-"

# ── 6. IAM: let Cloud Run's runtime service account use secrets/SQL/bucket ────
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
log "Granting IAM to runtime service account: $RUNTIME_SA"

for ROLE in roles/secretmanager.secretAccessor roles/cloudsql.client; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" --role="$ROLE" --condition=None >/dev/null
done

# Bucket access for the GCS volume mount (read/write audio).
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/storage.objectAdmin" >/dev/null

# ── 7. Apply database migrations (optional but recommended) ──────────────────
# Migrations live in $BACKEND_DIR/migrations/*.sql. Apply them with the Cloud SQL
# Auth Proxy or `gcloud sql connect`. Example (uncomment to run interactively):
# log "Applying migrations via gcloud sql connect..."
# for f in $(ls "$BACKEND_DIR"/migrations/*.sql | sort); do
#   echo "  -> $f"
#   gcloud sql connect "$SQL_INSTANCE" --user="$DB_USER" --database="$DB_NAME" < "$f"
# done
warn "Remember to apply DB migrations from $BACKEND_DIR/migrations/ (see README step 7)."

# ── 8. Build + deploy the backend to Cloud Run ───────────────────────────────
log "Building & deploying backend to Cloud Run via Cloud Build..."
gcloud builds submit \
  --config deploy/google-cloud/cloudbuild.yaml \
  --substitutions="_REGION=${REGION},_SERVICE=${SERVICE},_AR_REPO=${AR_REPO},_SQL_INSTANCE=${SQL_INSTANCE},_DB_NAME=${DB_NAME},_DB_USER=${DB_USER},_BUCKET=${BUCKET},_TAG=manual-$(date +%Y%m%d-%H%M%S)" \
  .

BACKEND_URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
log "Backend deployed: $BACKEND_URL"

# Now that we know the backend URL, lock CORS to the Firebase Hosting origins
# and point them at the live API.
FRONTEND_ORIGINS="https://${FIREBASE_SITE}.web.app,https://${FIREBASE_SITE}.firebaseapp.com"
# CORS_ORIGINS contains commas, so use the ^@^ delimiter form for --update-env-vars.
gcloud run services update "$SERVICE" --region="$REGION" \
  --update-env-vars="^@^CORS_ORIGINS=${FRONTEND_ORIGINS}" >/dev/null
log "CORS origins set to: $FRONTEND_ORIGINS"

# ── 9. Build + deploy the frontend to Firebase Hosting ───────────────────────
if command -v firebase >/dev/null 2>&1; then
  log "Building frontend with VITE_API_URL=${BACKEND_URL}/api ..."
  (
    cd "$FRONTEND_DIR"
    npm install
    VITE_API_URL="${BACKEND_URL}/api" npm run build
  )

  # Minimal firebase.json for an SPA, generated if not present.
  if [ ! -f "$FRONTEND_DIR/firebase.json" ]; then
    cat > "$FRONTEND_DIR/firebase.json" <<JSON
{
  "hosting": {
    "public": "dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  }
}
JSON
  fi

  ( cd "$FRONTEND_DIR" && firebase deploy --only hosting --project "$PROJECT_ID" )
  log "Frontend deployed to https://${FIREBASE_SITE}.web.app"
else
  warn "firebase CLI not found. Install with: npm i -g firebase-tools && firebase login"
  warn "Then build the frontend and deploy (see README step 9):"
  warn "  cd $FRONTEND_DIR && VITE_API_URL=${BACKEND_URL}/api npm run build && firebase deploy --only hosting"
fi

log "Done. Backend: $BACKEND_URL | Frontend: https://${FIREBASE_SITE}.web.app"
