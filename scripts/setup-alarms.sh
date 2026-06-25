#!/usr/bin/env bash
# =============================================================================
# setup-alarms.sh — Create CloudWatch alarms for Anot production (run once)
#
# Creates SNS-backed alarms for Elastic Beanstalk health, HTTP 5xx spikes,
# slow API response time, and database connectivity failures.
#
# Usage (from repo root):
#   ./scripts/setup-alarms.sh
#
# Prerequisites:
#   - AWS CLI v2 configured with permissions for cloudwatch:* and sns:*
#   - Optional: export ALERT_EMAIL=ops@anot.health to create/subscribe SNS topic
#
# Optional environment variables:
#   AWS_REGION          Region (default: ap-southeast-1)
#   EB_ENV_NAME         EB environment name (default: anot-backend-prod)
#   SNS_TOPIC_NAME      SNS topic for alerts (default: anot-prod-alerts)
#   ALERT_EMAIL         Email to subscribe to SNS (optional)
#   DRY_RUN             Set to 1 to print commands without executing
#
# Exit codes: 0 = success, 1 = failure
# =============================================================================

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
EB_ENV_NAME="${EB_ENV_NAME:-anot-backend-prod}"
SNS_TOPIC_NAME="${SNS_TOPIC_NAME:-anot-prod-alerts}"
ALARM_PREFIX="${ALARM_PREFIX:-anot-prod}"
DRY_RUN="${DRY_RUN:-0}"

# RDS instance identifier (from DEPLOYMENT_V40_SSM.md)
RDS_INSTANCE_ID="${RDS_INSTANCE_ID:-anot-postgres}"

# Thresholds (tune per ops runbook)
HTTP_5XX_THRESHOLD="${HTTP_5XX_THRESHOLD:-10}"          # sum over 5 min
HTTP_5XX_EVAL_PERIODS="${HTTP_5XX_EVAL_PERIODS:-2}"
LATENCY_THRESHOLD_SEC="${LATENCY_THRESHOLD_SEC:-3}"     # p95 target load balancer
LATENCY_EVAL_PERIODS="${LATENCY_EVAL_PERIODS:-3}"
DB_CONNECTION_THRESHOLD="${DB_CONNECTION_THRESHOLD:-1}" # DatabaseConnections drop

# ─── Helpers ──────────────────────────────────────────────────────────────────

section() {
  echo ""
  echo "================================================================================"
  echo "  $1"
  echo "================================================================================"
}

aws_run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "  [DRY-RUN] aws $*"
    return 0
  fi
  aws "$@" --region "${AWS_REGION}"
}

fail() {
  printf '  ❌ %s\n' "$1" >&2
  exit 1
}

pass() {
  printf '  ✅ %s\n' "$1"
}

ensure_aws_cli() {
  command -v aws >/dev/null 2>&1 || fail "AWS CLI not found"
  aws sts get-caller-identity --region "${AWS_REGION}" >/dev/null 2>&1 \
    || fail "AWS credentials not configured or insufficient"
  pass "AWS CLI authenticated (${AWS_REGION})"
}

get_or_create_sns_topic_arn() {
  local topic_arn
  topic_arn="$(aws sns list-topics --region "${AWS_REGION}" \
    --query "Topics[?contains(TopicArn, ':${SNS_TOPIC_NAME}')].TopicArn | [0]" \
    --output text 2>/dev/null || echo "None")"

  if [[ -z "${topic_arn}" || "${topic_arn}" == "None" ]]; then
    echo "  Creating SNS topic ${SNS_TOPIC_NAME}..." >&2
    if [[ "${DRY_RUN}" == "1" ]]; then
      echo "arn:aws:sns:${AWS_REGION}:625242092266:${SNS_TOPIC_NAME}"
      return 0
    fi
    topic_arn="$(aws sns create-topic --name "${SNS_TOPIC_NAME}" --region "${AWS_REGION}" --output text)"
  fi

  if [[ -n "${ALERT_EMAIL:-}" && "${DRY_RUN}" != "1" ]]; then
    aws sns subscribe \
      --topic-arn "${topic_arn}" \
      --protocol email \
      --notification-endpoint "${ALERT_EMAIL}" \
      --region "${AWS_REGION}" >/dev/null 2>&1 || true
    echo "  Subscribed ${ALERT_EMAIL} (confirm via email)" >&2
  fi

  echo "${topic_arn}"
}

put_alarm() {
  local name="$1"
  shift
  echo ""
  echo "  Alarm: ${name}"
  if aws_run cloudwatch put-metric-alarm \
    --alarm-name "${name}" \
    --alarm-description "Anot production — ${name}" \
    --actions-enabled \
    "$@"; then
    pass "${name} configured"
    return 0
  fi
  echo "  Warning: failed to create alarm ${name}" >&2
  return 1
}

# ─── Alarm definitions ────────────────────────────────────────────────────────

create_eb_health_alarm() {
  # EB enhanced health publishes EnvironmentHealth metric (1=Green, 15=Red, etc.)
  put_alarm "${ALARM_PREFIX}-eb-health-red" \
    --namespace "AWS/ElasticBeanstalk" \
    --metric-name EnvironmentHealth \
    --dimensions "Name=EnvironmentName,Value=${EB_ENV_NAME}" \
    --statistic Maximum \
    --period 60 \
    --evaluation-periods 2 \
    --threshold 15 \
    --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data breaching \
    --alarm-actions "${SNS_TOPIC_ARN}" \
    --ok-actions "${SNS_TOPIC_ARN}"
}

create_http_5xx_alarm() {
  if [[ -n "${LOAD_BALANCER_NAME:-}" && "${LOAD_BALANCER_NAME}" != "None" ]]; then
    if put_alarm "${ALARM_PREFIX}-http-5xx-spike" \
      --namespace "AWS/ApplicationELB" \
      --metric-name HTTPCode_Target_5XX_Count \
      --dimensions "Name=LoadBalancer,Value=${LOAD_BALANCER_NAME}" \
      --statistic Sum \
      --period 300 \
      --evaluation-periods "${HTTP_5XX_EVAL_PERIODS}" \
      --threshold "${HTTP_5XX_THRESHOLD}" \
      --comparison-operator GreaterThanThreshold \
      --treat-missing-data notBreaching \
      --alarm-actions "${SNS_TOPIC_ARN}" \
      --ok-actions "${SNS_TOPIC_ARN}"; then
      return 0
    fi
  fi

  echo "  Using EB ApplicationRequests5xx metric (ALB metric unavailable)"
  put_alarm "${ALARM_PREFIX}-http-5xx-spike" \
    --namespace "AWS/ElasticBeanstalk" \
    --metric-name ApplicationRequests5xx \
    --dimensions "Name=EnvironmentName,Value=${EB_ENV_NAME}" \
    --statistic Sum \
    --period 300 \
    --evaluation-periods "${HTTP_5XX_EVAL_PERIODS}" \
    --threshold "${HTTP_5XX_THRESHOLD}" \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${SNS_TOPIC_ARN}" \
    --ok-actions "${SNS_TOPIC_ARN}" \
    || fail "Failed to create HTTP 5xx alarm"
}

create_latency_alarm() {
  if [[ -n "${LOAD_BALANCER_NAME:-}" && "${LOAD_BALANCER_NAME}" != "None" ]]; then
    if put_alarm "${ALARM_PREFIX}-api-latency-slow" \
      --namespace "AWS/ApplicationELB" \
      --metric-name TargetResponseTime \
      --dimensions "Name=LoadBalancer,Value=${LOAD_BALANCER_NAME}" \
      --extended-statistic p95 \
      --period 60 \
      --evaluation-periods "${LATENCY_EVAL_PERIODS}" \
      --threshold "${LATENCY_THRESHOLD_SEC}" \
      --comparison-operator GreaterThanThreshold \
      --treat-missing-data notBreaching \
      --alarm-actions "${SNS_TOPIC_ARN}" \
      --ok-actions "${SNS_TOPIC_ARN}"; then
      return 0
    fi
  fi

  echo "  Using EB ApplicationLatencyP99 metric (ALB metric unavailable)"
  put_alarm "${ALARM_PREFIX}-api-latency-slow" \
    --namespace "AWS/ElasticBeanstalk" \
    --metric-name ApplicationLatencyP99 \
    --dimensions "Name=EnvironmentName,Value=${EB_ENV_NAME}" \
    --statistic Average \
    --period 60 \
    --evaluation-periods "${LATENCY_EVAL_PERIODS}" \
    --threshold "${LATENCY_THRESHOLD_SEC}" \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "${SNS_TOPIC_ARN}" \
    --ok-actions "${SNS_TOPIC_ARN}" \
    || fail "Failed to create latency alarm"
}

create_db_alarm() {
  # RDS DatabaseConnections — alert when connections drop to zero unexpectedly
  put_alarm "${ALARM_PREFIX}-database-disconnected" \
    --namespace "AWS/RDS" \
    --metric-name DatabaseConnections \
    --dimensions "Name=DBInstanceIdentifier,Value=${RDS_INSTANCE_ID}" \
    --statistic Average \
    --period 60 \
    --evaluation-periods 5 \
    --threshold "${DB_CONNECTION_THRESHOLD}" \
    --comparison-operator LessThanThreshold \
    --treat-missing-data breaching \
    --alarm-actions "${SNS_TOPIC_ARN}" \
    --ok-actions "${SNS_TOPIC_ARN}"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  section "ANOT CLOUDWATCH ALARMS SETUP"
  echo "  Region      : ${AWS_REGION}"
  echo "  EB env      : ${EB_ENV_NAME}"
  echo "  RDS instance: ${RDS_INSTANCE_ID}"
  echo "  SNS topic   : ${SNS_TOPIC_NAME}"
  echo "  Time        : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

  ensure_aws_cli

  SNS_TOPIC_ARN="$(get_or_create_sns_topic_arn)"
  echo "  SNS ARN     : ${SNS_TOPIC_ARN}"

  if [[ "${DRY_RUN}" != "1" ]]; then
    LOAD_BALANCER_NAME="$(aws elasticbeanstalk describe-environment-resources \
      --environment-name "${EB_ENV_NAME}" \
      --region "${AWS_REGION}" \
      --query 'EnvironmentResources.LoadBalancers[0].Name' \
      --output text 2>/dev/null || echo "")"
    if [[ -n "${LOAD_BALANCER_NAME}" && "${LOAD_BALANCER_NAME}" != "None" ]]; then
      echo "  Load balancer: ${LOAD_BALANCER_NAME}"
    fi
  fi

  section "Creating alarms"

  create_eb_health_alarm || fail "Failed to create EB health alarm"
  create_http_5xx_alarm || fail "Failed to create HTTP 5xx alarm"
  create_latency_alarm || fail "Failed to create latency alarm"
  create_db_alarm || fail "Failed to create database alarm"

  section "COMPLETE"
  echo "  Four production alarms registered under prefix '${ALARM_PREFIX}-*'"
  echo ""
  echo "  Verify in AWS Console → CloudWatch → Alarms, or run:"
  echo "    aws cloudwatch describe-alarms --alarm-name-prefix ${ALARM_PREFIX} --region ${AWS_REGION}"
  echo ""
  if [[ -n "${ALERT_EMAIL:-}" ]]; then
    echo "  Confirm the SNS email subscription before relying on email alerts."
  else
    echo "  Tip: re-run with ALERT_EMAIL=ops@anot.health to subscribe an on-call address."
  fi

  pass "CloudWatch alarms setup finished"
  exit 0
}

main "$@"
