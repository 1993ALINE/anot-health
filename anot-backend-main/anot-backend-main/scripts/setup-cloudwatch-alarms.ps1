# CloudWatch alarms for anot-backend-prod.
# Usage: .\scripts\setup-cloudwatch-alarms.ps1 [-SnsEmail you@example.com]

param(
  [string]$Region = 'ap-southeast-1',
  [string]$EnvironmentName = 'anot-backend-prod',
  [string]$SnsEmail = ''
)

$ErrorActionPreference = 'Stop'

$AccountId = aws sts get-caller-identity --query Account --output text
$SnsTopicName = 'anot-backend-prod-alerts'
$SnsArn = "arn:aws:sns:${Region}:${AccountId}:${SnsTopicName}"

Write-Host "Creating SNS topic $SnsTopicName..."
aws sns create-topic --name $SnsTopicName --region $Region | Out-Null

if ($SnsEmail) {
  aws sns subscribe --topic-arn $SnsArn --protocol email --notification-endpoint $SnsEmail --region $Region | Out-Null
  Write-Host "Subscribed $SnsEmail (confirm via email)"
}

Write-Host "Creating CloudWatch alarms..."

aws cloudwatch put-metric-alarm `
  --alarm-name anot-prod-eb-health-red `
  --alarm-description "Elastic Beanstalk environment health is Red" `
  --metric-name EnvironmentHealth `
  --namespace AWS/ElasticBeanstalk `
  --statistic Minimum `
  --period 60 `
  --evaluation-periods 2 `
  --threshold 20 `
  --comparison-operator LessThanOrEqualToThreshold `
  --dimensions Name=EnvironmentName,Value=$EnvironmentName `
  --alarm-actions $SnsArn `
  --region $Region | Out-Null
Write-Host "  anot-prod-eb-health-red"

aws cloudwatch put-metric-alarm `
  --alarm-name anot-prod-cpu-warn `
  --alarm-description "EB environment CPU > 70% for 10 minutes" `
  --metric-name CPUUtilization `
  --namespace AWS/ElasticBeanstalk `
  --statistic Average `
  --period 300 `
  --evaluation-periods 2 `
  --threshold 70 `
  --comparison-operator GreaterThanThreshold `
  --dimensions Name=EnvironmentName,Value=$EnvironmentName `
  --alarm-actions $SnsArn `
  --treat-missing-data notBreaching `
  --region $Region | Out-Null
Write-Host "  anot-prod-cpu-warn"

aws cloudwatch put-metric-alarm `
  --alarm-name anot-prod-cpu-critical `
  --alarm-description "EB environment CPU > 85% for 5 minutes" `
  --metric-name CPUUtilization `
  --namespace AWS/ElasticBeanstalk `
  --statistic Average `
  --period 300 `
  --evaluation-periods 1 `
  --threshold 85 `
  --comparison-operator GreaterThanThreshold `
  --dimensions Name=EnvironmentName,Value=$EnvironmentName `
  --alarm-actions $SnsArn `
  --treat-missing-data notBreaching `
  --region $Region | Out-Null
Write-Host "  anot-prod-cpu-critical"

Write-Host ""
Write-Host "Done. SNS topic: $SnsArn"
Write-Host "Verify: aws cloudwatch describe-alarms --alarm-name-prefix anot-prod --region $Region"
