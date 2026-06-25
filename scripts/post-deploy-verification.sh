#!/usr/bin/env bash
# =============================================================================
# post-deploy-verification.sh — Run AFTER every Anot production deployment
#
# Polls the public health endpoint for up to 5 minutes. Success = HTTP 200 with
# status=ok. Failure = rollback recommended.
#
# Usage (from repo root):
#   ./scripts/post-deploy-verification.sh
#
# Optional environment variables:
#   HEALTH_URL        Production health URL (default: https://app.anot.health/api/health)
#   POLL_TIMEOUT_SEC  Max seconds to poll (default: 300 = 5 minutes)
#   POLL_INTERVAL_SEC Seconds between attempts (default: 10)
#   EXPECT_VERSION    If set, JSON "version" field must match (optional gate)
#
# Exit codes: 0 = deployment verified, 1 = verification failed (rollback needed)
# =============================================================================

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

HEALTH_URL="${HEALTH_URL:-https://app.anot.health/api/health}"
POLL_TIMEOUT_SEC="${POLL_TIMEOUT_SEC:-300}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-10}"

# ─── Output helpers ───────────────────────────────────────────────────────────

section() {
  echo ""
  echo "================================================================================"
  echo "  $1"
  echo "================================================================================"
}

# ─── Health probe ─────────────────────────────────────────────────────────────

probe_health() {
  local response http_code body
  response="$(curl -sS -w '\n%{http_code}' --max-time 15 "${HEALTH_URL}" 2>&1)" || {
    echo "curl_error:${response}"
    return 1
  }

  http_code="$(echo "${response}" | tail -n1)"
  body="$(echo "${response}" | sed '$d')"

  if [[ "${http_code}" != "200" ]]; then
    echo "http_${http_code}:${body}"
    return 1
  fi

  if ! echo "${body}" | grep -qE '"status"[[:space:]]*:[[:space:]]*"(ok|healthy)"'; then
    echo "bad_body:${body}"
    return 1
  fi

  if [[ -n "${EXPECT_VERSION:-}" ]]; then
    if ! echo "${body}" | grep -qE "\"version\"[[:space:]]*:[[:space:]]*\"${EXPECT_VERSION}\""; then
      echo "version_mismatch:${body}"
      return 1
    fi
  fi

  echo "${body}"
  return 0
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  section "ANOT POST-DEPLOYMENT VERIFICATION"
  echo "  URL     : ${HEALTH_URL}"
  echo "  Timeout : ${POLL_TIMEOUT_SEC}s (${POLL_INTERVAL_SEC}s interval)"
  echo "  Time    : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

  local deadline=$(( $(date +%s) + POLL_TIMEOUT_SEC ))
  local attempt=0
  local last_error=""

  while (( $(date +%s) < deadline )); do
    attempt=$((attempt + 1))
    local remaining=$(( deadline - $(date +%s) ))

    printf '\n  Poll %d (%.0fs remaining)... ' "${attempt}" "${remaining}"

    local result
    if result="$(probe_health)"; then
      echo "200 OK"
      section "RESULT"
      echo "  ✅ Deployment successful"
      echo "  Response: ${result}"
      exit 0
    else
      last_error="${result}"
      echo "failed (${last_error})"
    fi

    sleep "${POLL_INTERVAL_SEC}"
  done

  section "RESULT"
  echo "  ❌ Deployment verification FAILED after ${POLL_TIMEOUT_SEC}s"
  echo "  Last error: ${last_error}"
  echo ""
  echo "  Recommended actions:"
  echo "    1. Check EB environment health: aws elasticbeanstalk describe-environments \\"
  echo "         --environment-names anot-backend-prod --region ap-southeast-1"
  echo "    2. Review EB logs: eb logs anot-backend-prod (or CloudWatch /var/log/web.stdout.log)"
  echo "    3. Rollback — see docs/DEPLOYMENT_RUNBOOK.md § Rollback procedure"
  echo ""
  echo "  ❌ ROLLBACK NEEDED"
  exit 1
}

main "$@"
