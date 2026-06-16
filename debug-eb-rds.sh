#!/usr/bin/env bash
# =============================================================================
# debug-eb-rds.sh — Diagnose "EB can't reach RDS / Node not on 8080"
#
# Two parts:
#   PART A  AWS CLI control-plane checks  → run from your laptop (needs AWS creds)
#   PART B  On-instance data-plane checks → run ON the EB instance (eb ssh / SSM)
#
# Usage:
#   chmod +x debug-eb-rds.sh
#   ./debug-eb-rds.sh aws      # Part A  (control plane, from laptop)
#   ./debug-eb-rds.sh node     # Part B  (data plane, on the EB box)
#   ./debug-eb-rds.sh all      # both (only makes sense when run on the box w/ creds)
# =============================================================================
set -uo pipefail

REGION="ap-southeast-1"
EB_ENV_NAME="anot-backend-prod"
EB_ENV_ID="e-g7bj3ndsck"
RDS_HOST="anot-postgres.c5casia24do8.ap-southeast-1.rds.amazonaws.com"
RDS_PORT="5432"
RDS_DB_INSTANCE="anot-postgres"   # adjust if the DBInstanceIdentifier differs

line(){ printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m[ OK ]\033[0m %s\n' "$*"; }
bad(){ printf '\033[1;31m[FAIL]\033[0m %s\n' "$*"; }

# -----------------------------------------------------------------------------
part_aws() {
  command -v aws >/dev/null || { bad "aws CLI not found"; return 1; }

  line "1. EB environment health + the EC2 instances behind it"
  aws elasticbeanstalk describe-environment-health \
    --environment-name "$EB_ENV_NAME" --attribute-names All \
    --region "$REGION" --output table || true
  aws elasticbeanstalk describe-environment-resources \
    --environment-id "$EB_ENV_ID" --region "$REGION" \
    --query 'EnvironmentResources.Instances[].Id' --output text

  line "2. EB environment variables (is DATABASE_URL / DB_SSL set? sslmode in it?)"
  aws elasticbeanstalk describe-configuration-settings \
    --environment-name "$EB_ENV_NAME" --application-name "$EB_ENV_NAME" \
    --region "$REGION" \
    --query "ConfigurationSettings[0].OptionSettings[?Namespace=='aws:elasticbeanstalk:application:environment']" \
    --output table 2>/dev/null \
    || echo "  (pass the correct --application-name; list with: aws elasticbeanstalk describe-applications --region $REGION)"

  line "3. RDS instance: status, public access, the SG attached, the subnet group"
  aws rds describe-db-instances --db-instance-identifier "$RDS_DB_INSTANCE" \
    --region "$REGION" \
    --query 'DBInstances[0].{Status:DBInstanceStatus,Endpoint:Endpoint.Address,Port:Endpoint.Port,Public:PubliclyAccessible,VpcSG:VpcSecurityGroups,Subnets:DBSubnetGroup.Subnets[].SubnetIdentifier}' \
    --output json

  line "4. Does RDS FORCE TLS? (rds.force_ssl=1 means you cannot connect plaintext)"
  PG_GROUP=$(aws rds describe-db-instances --db-instance-identifier "$RDS_DB_INSTANCE" \
    --region "$REGION" --query 'DBInstances[0].DBParameterGroups[0].DBParameterGroupName' --output text)
  echo "  Parameter group: $PG_GROUP"
  aws rds describe-db-parameters --db-parameter-group-name "$PG_GROUP" \
    --region "$REGION" --query "Parameters[?ParameterName=='rds.force_ssl'].[ParameterName,ParameterValue]" \
    --output table

  line "5. SECURITY GROUP CHECK — does the RDS SG allow 5432 from the EB instances' SG?"
  RDS_SG=$(aws rds describe-db-instances --db-instance-identifier "$RDS_DB_INSTANCE" \
    --region "$REGION" --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)
  echo "  RDS security group: $RDS_SG"
  aws ec2 describe-security-groups --group-ids "$RDS_SG" --region "$REGION" \
    --query 'SecurityGroups[0].IpPermissions[?FromPort==`5432`]' --output json
  echo "  ^ Confirm a rule for TCP 5432 sourced from the EB instances' security group (UserIdGroupPairs)."

  line "6. Same VPC? Compare EB instance subnet VPC vs RDS subnet VPC"
  INSTANCE_ID=$(aws elasticbeanstalk describe-environment-resources \
    --environment-id "$EB_ENV_ID" --region "$REGION" \
    --query 'EnvironmentResources.Instances[0].Id' --output text)
  echo "  EB instance: $INSTANCE_ID"
  aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --region "$REGION" \
    --query 'Reservations[0].Instances[0].{VpcId:VpcId,Subnet:SubnetId,SGs:SecurityGroups[].GroupId}' \
    --output json

  line "7. Pull the last crash logs straight from the environment"
  aws elasticbeanstalk request-environment-info --environment-id "$EB_ENV_ID" \
    --info-type tail --region "$REGION" >/dev/null 2>&1 || true
  sleep 8
  aws elasticbeanstalk retrieve-environment-info --environment-id "$EB_ENV_ID" \
    --info-type tail --region "$REGION" \
    --query 'EnvironmentInfo[].Message' --output text || true
}

# -----------------------------------------------------------------------------
part_node() {
  line "A. Is the Node container even running / what is it doing?"
  if command -v docker >/dev/null; then
    sudo docker ps -a || true
    CID=$(sudo docker ps -aq | head -n1)
    echo "  --- last 60 log lines from container $CID ---"
    [ -n "$CID" ] && sudo docker logs --tail 60 "$CID" 2>&1 || true
  fi

  line "B. Is anything listening on 8080? (nginx 111 means: nothing is)"
  (sudo ss -lntp 2>/dev/null || sudo netstat -lntp 2>/dev/null) | grep -E ':8080|:5000' || \
    bad "Nothing on 8080 — Node crashed before app.listen(). Confirms the cascade."

  line "C. NETWORK layer — is RDS:5432 reachable at the TCP level?"
  # TCP timeout here => security group / VPC / routing problem.
  # TCP success here => SG/VPC are FINE; the issue is TLS/app layer.
  if command -v nc >/dev/null; then
    timeout 8 nc -zv "$RDS_HOST" "$RDS_PORT" \
      && ok "TCP 5432 OPEN → security group + routing are fine; NOT a network problem" \
      || bad "TCP 5432 unreachable → THIS is a security group / VPC / route problem"
  else
    timeout 8 bash -c "cat < /dev/null > /dev/tcp/$RDS_HOST/$RDS_PORT" \
      && ok "TCP 5432 OPEN → SG/routing fine" \
      || bad "TCP 5432 unreachable → SG/VPC problem"
  fi

  line "D. TLS layer — WHAT certificate is the endpoint actually presenting?"
  # Real RDS => issuer is 'Amazon RDS ... CA'. A self-signed cert here means
  # you are NOT talking to real RDS (interception / wrong endpoint).
  if command -v openssl >/dev/null; then
    echo | timeout 10 openssl s_client -starttls postgres \
      -connect "$RDS_HOST:$RDS_PORT" -showcerts 2>/dev/null \
      | openssl x509 -noout -issuer -subject 2>/dev/null \
      || echo "  (could not parse cert — try without -starttls on older openssl)"
    echo "  EXPECT issuer to contain 'Amazon RDS'. If issuer==subject (self-signed) → interception."
  fi

  line "E. APP layer — connect with the Amazon RDS CA bundle (the correct fix)"
  CA=/tmp/rds-ca.pem
  curl -fsSL -o "$CA" \
    "https://truststore.pki.rds.amazonaws.com/${REGION}/${REGION}-bundle.pem" \
    && ok "Downloaded RDS CA bundle to $CA" || bad "Could not download RDS CA bundle"
  echo "  Verified connect (rejects bad certs):"
  echo "    PGSSLMODE=verify-full PGSSLROOTCERT=$CA psql 'host=$RDS_HOST port=$RDS_PORT dbname=postgres user=YOURUSER' -c 'select 1;'"

  line "F. Confirm WHICH db.js is deployed (stale-deploy check)"
  if command -v docker >/dev/null && [ -n "${CID:-}" ]; then
    sudo docker exec "$CID" sh -c 'grep -n "rejectUnauthorized" src/config/db.js' 2>/dev/null \
      || echo "  rejectUnauthorized NOT found in the running image → STALE DEPLOY confirmed."
  fi
  echo "  Also dump the resolved env the container sees:"
  [ -n "${CID:-}" ] && sudo docker exec "$CID" sh -c 'echo "DATABASE_URL=$DATABASE_URL"; echo "DB_SSL=$DB_SSL"; echo "NODE_TLS_REJECT_UNAUTHORIZED=$NODE_TLS_REJECT_UNAUTHORIZED"' 2>/dev/null || true
}

case "${1:-all}" in
  aws)  part_aws ;;
  node) part_node ;;
  all)  part_aws; part_node ;;
  *) echo "usage: $0 [aws|node|all]"; exit 1 ;;
esac
