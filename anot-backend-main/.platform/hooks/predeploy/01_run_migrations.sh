#!/bin/bash
# AL2023 Node.js platform: container_commands in .ebextensions are not supported.
# This predeploy hook runs once per instance before the new version goes live.
set -euo pipefail
cd /var/app/staging
echo "[predeploy] Running database migrations (timeout 600s)..."
timeout 600 npm run migrate:prod
echo "[predeploy] Database migrations complete."
