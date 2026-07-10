# ─────────────────────────────────────────────────────────────────────────────
# Anot backend — production container for Google Cloud Run
#
# Notes:
#  - ffmpeg is required at runtime (audio preprocessing in
#    src/services/audioProcessingService.js spawns the `ffmpeg` binary).
#  - The app listens on $PORT (Cloud Run injects PORT=8080). src/server.js
#    already reads process.env.PORT and binds 0.0.0.0.
#  - Audio uploads are written to src/uploads. On Cloud Run that path should be
#    backed by a Cloud Storage volume mount (see deploy/google-cloud/README.md),
#    otherwise files are lost when an instance is recycled.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: install production dependencies ────────────────────────────────
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# Copy only manifests first for better layer caching.
COPY package.json package-lock.json* ./

# The `anot-workspace` (file:../..) dependency is a monorepo root link that is
# not used by the backend source and cannot resolve inside the container, so we
# drop it before installing. We then install only production dependencies.
RUN npm pkg delete dependencies.anot-workspace \
 && npm install --omit=dev --no-audit --no-fund

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# DB_SSL_CA points at the Amazon RDS CA bundle baked in below, so db.js verifies
# the RDS server certificate (HIPAA: encrypted + authenticated DB connection).
ENV NODE_ENV=production \
    PORT=8080 \
    DB_SSL_CA=/opt/rds/rds-ca.pem

# ffmpeg is required at runtime (audio preprocessing); ca-certificates + curl are
# needed to fetch the RDS CA bundle over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Amazon RDS global CA bundle (covers ap-southeast-1 and all regions). db.js
# verifies the RDS server cert against this, so we never disable TLS validation.
RUN mkdir -p /opt/rds \
 && curl -fsSL -o /opt/rds/rds-ca.pem \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
 && test -s /opt/rds/rds-ca.pem

WORKDIR /app

# Bring in installed node_modules from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy application source.
COPY . .

# Ensure the uploads directory exists (used as a GCS volume mount target on Cloud Run).
RUN mkdir -p src/uploads

# Drop root privileges (the node image ships a non-root `node` user).
RUN chown -R node:node /app
USER node

EXPOSE 8080

CMD ["node", "src/server.js"]
