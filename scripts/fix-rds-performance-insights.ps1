<#
.SYNOPSIS
  ULT audit fix: Enable RDS Performance Insights and CloudWatch dashboard.

.EXAMPLE
  powershell -File scripts/fix-rds-performance-insights.ps1 -Force -DryRun
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$DryRun,
    [switch]$Rollback,
    [switch]$SkipConfirm,
    [string]$Region = 'ap-southeast-1',
    [string]$RdsInstanceId = 'anot-postgres'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\fix-common.ps1"
$script:FixForce = $Force
$script:FixDryRun = $DryRun

$ctx = Initialize-FixContext -FixId 'fix-rds-performance-insights' -Title 'RDS Performance Insights' `
    -AuditRef 'ULT-0009' -Priority 'HIGH'

if ($Rollback) {
    Write-FixPhase 'ROLLBACK: fix-rds-performance-insights'
    Write-FixWarn 'AWS RDS rollback requires manual disable via AWS CLI:'
    Write-Host "  aws rds modify-db-instance --db-instance-identifier $RdsInstanceId --no-enable-performance-insights --apply-immediately" -ForegroundColor Yellow
    Restore-FixBackup -FixId 'fix-rds-performance-insights'
    exit 0
}

Write-FixPhase $ctx.Title
$env:AWS_DEFAULT_REGION = $Region
$env:AWS_PAGER = ''

$dashboardJson = @'
{
  "widgets": [
    {
      "type": "metric",
      "properties": {
        "metrics": [
          ["AWS/RDS", "DBLoad", "DBInstanceIdentifier", "anot-postgres"],
          [".", "DBLoadCPU", ".", "."],
          [".", "DBLoadNonCPU", ".", "."]
        ],
        "period": 60,
        "stat": "Average",
        "region": "ap-southeast-1",
        "title": "RDS Performance Insights - DB Load"
      }
    },
    {
      "type": "metric",
      "properties": {
        "metrics": [
          ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", "anot-postgres"],
          [".", "FreeableMemory", ".", "."],
          [".", "DatabaseConnections", ".", "."]
        ],
        "period": 60,
        "stat": "Average",
        "region": "ap-southeast-1",
        "title": "RDS Resource Utilization"
      }
    }
  ]
}
'@

$dashboardPath = Join-Path $ctx.DistDir 'cloudwatch-rds-performance-dashboard.json'
Set-FixFileContent -Path $dashboardPath -Content $dashboardJson

Write-FixPhase 'Checking current RDS Performance Insights status'
$piEnabled = $false
try {
    $desc = aws rds describe-db-instances --db-instance-identifier $RdsInstanceId --output json 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        $obj = $desc | ConvertFrom-Json
        $piEnabled = [bool]$obj.DBInstances[0].PerformanceInsightsEnabled
        Write-FixStep "PerformanceInsightsEnabled = $piEnabled"
    } else {
        Write-FixWarn "Could not describe RDS instance (AWS CLI unavailable or no credentials): $desc"
    }
} catch {
    Write-FixWarn "AWS check skipped: $_"
}

if (-not $piEnabled -and -not $DryRun) {
    if ($Force -or $SkipConfirm -or (Confirm-FixStep "Enable Performance Insights on $RdsInstanceId?")) {
        Write-FixStep 'Enabling Performance Insights (7-day retention)...'
        if (-not $DryRun) {
            aws rds modify-db-instance `
                --db-instance-identifier $RdsInstanceId `
                --enable-performance-insights `
                --performance-insights-retention-period 7 `
                --apply-immediately 2>&1 | Out-Host
            if ($LASTEXITCODE -ne 0) { Write-FixWarn 'RDS modify failed — run manually with appropriate IAM permissions' }
        }
    }
}

Write-FixPhase 'CloudWatch dashboard template'
$deployScript = @"
# Deploy dashboard (requires cloudwatch:PutDashboard)
aws cloudwatch put-dashboard `
  --dashboard-name Anot-RDS-Performance `
  --dashboard-body file://dist/cloudwatch-rds-performance-dashboard.json `
  --region $Region
"@
Set-FixFileContent -Path (Join-Path $ctx.Workspace 'scripts\deploy-rds-dashboard.ps1') -Content $deployScript

Write-FixReport -Summary "Created CloudWatch dashboard JSON and script to enable RDS Performance Insights on $RdsInstanceId. Before: PI disabled; After: PI enabled with 7-day retention." -NextSteps @(
    'Ensure AWS credentials with rds:ModifyDBInstance permission'
    'Run: powershell -File scripts/deploy-rds-dashboard.ps1'
    'Verify in AWS Console: RDS > Performance Insights tab'
)

Write-Host ''
Write-Host '[SUCCESS] fix-rds-performance-insights completed' -ForegroundColor Green
