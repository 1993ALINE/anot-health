#!/usr/bin/env bash
# =============================================================================
# pre-deploy-checklist.sh — Run BEFORE every Anot backend deployment
#
# Validates tests, migrations, startup, health endpoint, SSM parameters,
# database connectivity, and that migrations/ are included in the deploy zip.
#
# Usage (from repo root):
#   ./scripts/pre-deploy-checklist.sh
#
# Optional environment variables:
#   BACKEND_DIR     Path to backend project (default: anot-backend-main/anot-backend-main)
#   AWS_REGION      AWS region for SSM checks (default: ap-southeast-1)
#   SSM_PREFIX      SSM path prefix (default: /anot/prod)
#   HEALTH_URL      Local health URL (default: http://localhost:${PORT:-5000}/api/health)
#   DEPLOY_ZIP      Path to deployment zip to inspect (default: newest *.zip in $TMPDIR)
#   SKIP_SSM        Set to 1 to skip AWS SSM parameter checks (local-only runs)
#   SKIP_DB         Set to 1 to skip live database connectivity check
#   SKIP_ZIP        Set to 1 to skip migrations-in-zip verification
#   STARTUP_TIMEOUT Seconds to wait for server startup (default: 45)
#
# Exit codes: 0 = all checks passed, 1 = one or more checks failed (STOP deploy)
# =============================================================================

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${BACKEND_DIR:-${REPO_ROOT}/anot-backend-main/anot-backend-main}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
SSM_PREFIX="${SSM_PREFIX:-/anot/prod}"
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-45}"
LOCAL_PORT="${PORT:-5000}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${LOCAL_PORT}/api/health}"

# Required SSM parameters (see docs/SSM_PARAMETERS.md)
REQUIRED_SSM_PARAMS=(
  "${SSM_PREFIX}/JWT_SECRET"
  "${SSM_PREFIX}/SETTINGS_ENCRYPTION_KEY"
  "${SSM_PREFIX}/DB_PASSWORD"
  "${SSM_PREFIX}/DEEPGRAM_WEBHOOK_SECRET"
)

OPTIONAL_SSM_PARAMS=(
  "${SSM_PREFIX}/DB_HOST"
  "${SSM_PREFIX}/RATE_LIMIT_LOGIN_MAX"
  "${SSM_PREFIX}/RATE_LIMIT_LOGIN_WINDOW_MINUTES"
  "${SSM_PREFIX}/RATE_LIMIT_API_MAX"
  "${SSM_PREFIX}/RATE_LIMIT_API_WINDOW_MINUTES"
)

SERVER_PID=""
FAILED=0
PASSED=0

# ─── Output helpers ───────────────────────────────────────────────────────────

pass() {
  PASSED=$((PASSED + 1))
  printf '  ✅ %s\n' "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf '  ❌ %s\n' "$1" >&2
}

section() {
  echo ""
  echo "================================================================================"
  echo "  $1"
  echo "================================================================================"
}

cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo ""
    echo "  Stopping temporary server (PID ${SERVER_PID})..."
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

run_check() {
  local name="$1"
  shift
  echo ""
  echo "── Check: ${name} ──"
  if "$@"; then
    pass "${name}"
    return 0
  else
    fail "${name}"
    return 1
  fi
}

# ─── Individual checks ────────────────────────────────────────────────────────

check_backend_dir() {
  [[ -d "${BACKEND_DIR}" ]] || { echo "Backend directory not found: ${BACKEND_DIR}" >&2; return 1; }
  [[ -f "${BACKEND_DIR}/package.json" ]] || { echo "Missing package.json in ${BACKEND_DIR}" >&2; return 1; }
  return 0
}

check_npm_test() {
  local output
  if ! output="$(cd "${BACKEND_DIR}" && npm test 2>&1)"; then
    echo "${output}" >&2
    return 1
  fi

  if ! echo "${output}" | grep -qE 'Tests:[[:space:]]+71 passed, 71 total'; then
    echo "Expected 71/71 tests to pass. Actual summary:" >&2
    echo "${output}" | grep -E 'Tests:|Test Suites:' >&2 || echo "${output}" >&2
    return 1
  fi

  echo "  71/71 tests passed"
  return 0
}

check_migrate() {
  local output
  if ! output="$(cd "${BACKEND_DIR}" && npm run migrate 2>&1)"; then
    echo "${output}" >&2
    return 1
  fi
  echo "${output}" | tail -5
  return 0
}

check_server_start() {
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/anot-predeploy-server.XXXXXX.log")"

  (
    cd "${BACKEND_DIR}"
    npm start
  ) >"${log_file}" 2>&1 &
  SERVER_PID=$!

  local elapsed=0
  while (( elapsed < STARTUP_TIMEOUT )); do
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      echo "Server process exited early. Log:" >&2
      cat "${log_file}" >&2
      rm -f "${log_file}"
      return 1
    fi

    if curl -sf --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
      echo "  Server started (PID ${SERVER_PID}), log tail:"
      tail -5 "${log_file}"
      rm -f "${log_file}"
      return 0
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  echo "Server did not become ready within ${STARTUP_TIMEOUT}s. Log:" >&2
  cat "${log_file}" >&2
  rm -f "${log_file}"
  return 1
}

check_health_endpoint() {
  local response http_code body
  response="$(curl -sS -w '\n%{http_code}' --max-time 10 "${HEALTH_URL}" 2>&1)" || {
    echo "curl failed: ${response}" >&2
    return 1
  }

  http_code="$(echo "${response}" | tail -n1)"
  body="$(echo "${response}" | sed '$d')"

  if [[ "${http_code}" != "200" ]]; then
    echo "Expected HTTP 200, got ${http_code}. Body: ${body}" >&2
    return 1
  fi

  if ! echo "${body}" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    echo "Health body missing status=ok: ${body}" >&2
    return 1
  fi

  echo "  GET ${HEALTH_URL} → 200 OK (${body})"
  return 0
}

check_ssm_parameters() {
  if [[ "${SKIP_SSM:-0}" == "1" ]]; then
    echo "  Skipped (SKIP_SSM=1)"
    return 0
  fi

  if ! command -v aws >/dev/null 2>&1; then
    echo "AWS CLI not found — required for SSM verification" >&2
    return 1
  fi

  local missing=()
  local name

  for name in "${REQUIRED_SSM_PARAMS[@]}"; do
    if ! aws ssm get-parameter \
      --name "${name}" \
      --region "${AWS_REGION}" \
      --with-decryption \
      --output text >/dev/null 2>&1; then
      missing+=("${name}")
    fi
  done

  if ((${#missing[@]} > 0)); then
    echo "Missing required SSM parameters:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    return 1
  fi

  echo "  All ${#REQUIRED_SSM_PARAMS[@]} required SSM parameters exist under ${SSM_PREFIX}"

  local optional_missing=0
  for name in "${OPTIONAL_SSM_PARAMS[@]}"; do
    if ! aws ssm get-parameter \
      --name "${name}" \
      --region "${AWS_REGION}" \
      --output text >/dev/null 2>&1; then
        echo "  (optional missing: ${name})"
        optional_missing=$((optional_missing + 1))
      fi
  done

  if ((optional_missing > 0)); then
    echo "  ${optional_missing} optional parameter(s) missing — not blocking deploy"
  fi

  return 0
}

check_database_connectivity() {
  if [[ "${SKIP_DB:-0}" == "1" ]]; then
    echo "  Skipped (SKIP_DB=1)"
    return 0
  fi

  local result
  if ! result="$(cd "${BACKEND_DIR}" && node -e "
    require('dotenv').config();
    const { Pool } = require('pg');
    const pool = new Pool();
    pool.query('SELECT 1 AS ok')
      .then(r => { console.log('connected:', r.rows[0].ok); return pool.end(); })
      .catch(e => { console.error(e.message); process.exit(1); });
  " 2>&1)"; then
    echo "${result}" >&2
    echo "  Ensure .env has DATABASE_URL or DB_* credentials for the target database." >&2
    return 1
  fi

  echo "  ${result}"
  return 0
}

check_migrations_in_zip() {
  if [[ "${SKIP_ZIP:-0}" == "1" ]]; then
    echo "  Skipped (SKIP_ZIP=1)"
    return 0
  fi

  local zip_file="${DEPLOY_ZIP:-}"
  if [[ -z "${zip_file}" ]]; then
    zip_file="$(find "${TMPDIR:-/tmp}" "${REPO_ROOT}" -maxdepth 2 -name 'anot-backend-*.zip' -type f 2>/dev/null \
      | sort -r | head -n1 || true)"
  fi

  if [[ -z "${zip_file}" || ! -f "${zip_file}" ]]; then
    echo "  No deployment zip found — building a dry-run artifact to verify contents..."
    zip_file="$(mktemp "${TMPDIR:-/tmp}/anot-predeploy-dryrun.XXXXXX.zip")"
    (
      cd "${BACKEND_DIR}"
      tar -a -c -f "${zip_file}" \
        --exclude node_modules \
        --exclude .git \
        --exclude coverage \
        --exclude .env \
        --exclude '*.zip' \
        migrations package.json scripts/run-migrations.js .ebextensions
    ) || return 1
  fi

  if ! command -v unzip >/dev/null 2>&1; then
    echo "unzip not found — cannot inspect ${zip_file}" >&2
    return 1
  fi

  local migration_count
  migration_count="$(unzip -l "${zip_file}" 2>/dev/null | grep -c 'migrations/.*\.sql' || true)"

  if [[ "${migration_count}" -lt 1 ]]; then
    echo "Deployment zip ${zip_file} contains no migrations/*.sql files" >&2
    unzip -l "${zip_file}" | head -30 >&2 || true
    return 1
  fi

  if ! unzip -l "${zip_file}" 2>/dev/null | grep -q 'scripts/run-migrations.js'; then
    echo "Deployment zip missing scripts/run-migrations.js (EB container hook dependency)" >&2
    return 1
  fi

  echo "  ${zip_file}: ${migration_count} migration file(s), run-migrations.js present"
  return 0
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  section "ANOT PRE-DEPLOYMENT CHECKLIST"
  echo "  Backend : ${BACKEND_DIR}"
  echo "  Region  : ${AWS_REGION}"
  echo "  SSM     : ${SSM_PREFIX}"
  echo "  Health  : ${HEALTH_URL}"
  echo "  Time    : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

  check_backend_dir || { fail "Backend directory"; exit 1; }

  # Run checks; continue on failure to report all issues, but exit 1 at end.
  run_check "npm test (71/71 pass)" check_npm_test || true
  run_check "npm run migrate" check_migrate || true
  run_check "npm start (server boots cleanly)" check_server_start || true
  run_check "curl health endpoint (200 OK)" check_health_endpoint || true
  run_check "SSM parameters exist" check_ssm_parameters || true
  run_check "database connectivity" check_database_connectivity || true
  run_check "migrations/ in deployment zip" check_migrations_in_zip || true

  section "SUMMARY"
  echo "  Passed: ${PASSED}"
  echo "  Failed: ${FAILED}"

  if ((FAILED > 0)); then
    echo ""
    echo "  ❌ PRE-DEPLOY CHECKLIST FAILED — STOP DEPLOYMENT"
    echo "  Fix the failed checks above before running deploy-to-eb.ps1"
    exit 1
  fi

  echo ""
  echo "  ✅ ALL CHECKS PASSED — safe to deploy"
  exit 0
}

main "$@"
