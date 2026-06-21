<#
================================================================================
 enable-rds-enhanced-monitoring.ps1  -  Turn on RDS Enhanced Monitoring for the
                                        'anot-postgres' database
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 THE GOAL:
   Enable RDS ENHANCED MONITORING on the DB instance 'anot-postgres'. Enhanced
   monitoring publishes OS-level metrics (CPU, memory, file system, disk I/O,
   per-process stats) gathered by an agent ON the DB host, at a 60-second
   granularity, into CloudWatch Logs (log group 'RDSOSMetrics'). This is finer
   and lower-level than the default CloudWatch RDS metrics (which are scraped
   from the hypervisor at 60s and lack per-process detail).

 HOW IT WORKS:
   1) RDS needs an IAM role it can assume to push the OS metrics to CloudWatch
      Logs. The role trusts the service principal 'monitoring.rds.amazonaws.com'
      and carries the AWS-managed policy 'AmazonRDSEnhancedMonitoringRole'.
   2) The instance is then modified with:
         MonitoringInterval = 60   (seconds; 0 = disabled; 1/5/10/15/30/60 valid)
         MonitoringRoleArn  = <that role's ARN>
         ApplyImmediately   = true
      MonitoringInterval/RoleArn changes apply WITHOUT a reboot, but the request
      still moves the instance through 'modifying' before returning to
      'available', so we wait.

 WHAT THIS SCRIPT DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks; confirm the DB instance exists.
   Phase 1     Ensure the IAM role 'rds-monitoring-role' exists (create with the
               correct trust policy if missing). Idempotent.
   Phase 2     Attach the managed policy 'AmazonRDSEnhancedMonitoringRole'.
               Idempotent (attach is a no-op if already attached).
   Phase 3     modify-db-instance: MonitoringInterval=60 + role + apply-now.
               Skipped if monitoring is already enabled with this role.
   Phase 4     Poll the instance until Status=available.
   Phase 5     Verify MonitoringInterval=60 and print the CloudWatch endpoint.

 SAFETY:
   * Idempotent end-to-end: re-running detects the role, the attachment, and an
     already-enabled monitoring config and skips the corresponding work.
   * -DryRun does every read-only check and prints exactly which mutating calls
     WOULD run, without creating IAM resources or modifying the DB instance.
   * Enabling enhanced monitoring is NON-destructive and needs no reboot, but
     the modify still prompts for confirmation unless -Force / -SkipConfirm.

 USAGE:
   powershell -File scripts/enable-rds-enhanced-monitoring.ps1 -DryRun  # rehearse
   powershell -File scripts/enable-rds-enhanced-monitoring.ps1          # apply (prompts)
   powershell -File scripts/enable-rds-enhanced-monitoring.ps1 -Force   # apply, no prompts
   powershell -File scripts/enable-rds-enhanced-monitoring.ps1 -MonitoringInterval 30
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun,
    [ValidateSet(1, 5, 10, 15, 30, 60)]
    [int]$MonitoringInterval = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId   = '625242092266'
$Region         = 'ap-southeast-1'
$RdsInstanceId  = 'anot-postgres'

$MonitoringRoleName = 'rds-monitoring-role'
$ManagedPolicyArn   = 'arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole'
$MonitoringPrincipal = 'monitoring.rds.amazonaws.com'

# The CloudWatch Logs group RDS writes OS metrics to once monitoring is on.
$OsMetricsLogGroup = 'RDSOSMetrics'

$MaxStatusRetries   = 40     # availability can take a few minutes after modify
$StatusDelaySeconds = 15

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'

$env:AWS_DEFAULT_REGION = $Region
$env:AWS_PAGER = ''                  # disable the AWS CLI v2 pager (silent-fail source)
$script:CurrentPhase = 'startup'
#endregion

#region --------------------------- HELPERS -----------------------------------
function Write-Phase {
    param([string]$Title)
    $script:CurrentPhase = $Title
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}
function Write-Step { param([string]$Message) Write-Host "  -> $Message" -ForegroundColor Gray }
function Write-Ok   { param([string]$Message) Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  [!!] $Message" -ForegroundColor Yellow }
function Write-Diag { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }

function Confirm-Step {
    param([string]$Message)
    if ($DryRun)                 { Write-Step "[DRY-RUN] would prompt: $Message"; return }
    if ($Force -or $SkipConfirm) { Write-Step "$Message (auto-confirmed)"; return }
    $answer = Read-Host "  ?? $Message  [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw "Aborted by operator at: $Message" }
}

# Single choke point for every AWS CLI call. Captures stdout and stderr WITHOUT
# corrupting JSON: merges with 2>&1 then splits by object type (stdout = strings,
# stderr = ErrorRecord objects). Temporarily relaxes $ErrorActionPreference so a
# native command writing to stderr (even on exit 0) does not raise a terminating
# NativeCommandError before we read the real exit code. Retries with backoff and,
# on failure, throws a detailed, copy-pasteable diagnostic. -SkipInDryRun marks a
# mutating call (skipped + printed in -DryRun).
function Invoke-Aws {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [int]$Retries = 1,
        [int]$DelaySeconds = 5,
        [switch]$SkipInDryRun,
        [string]$What,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs
    )

    if (-not $CliArgs -or $CliArgs.Count -eq 0) { throw 'Invoke-Aws called with no AWS CLI arguments.' }
    $cmdText = "aws $($CliArgs -join ' ')"
    $label   = if ($What) { $What } else { $cmdText }

    if ($DryRun -and $SkipInDryRun) {
        Write-Host "    [DRY-RUN] skip mutating call: $cmdText" -ForegroundColor DarkYellow
        return ''
    }

    $attempt = 0
    while ($true) {
        $attempt++
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $captured = & aws @CliArgs 2>&1
            $code = $LASTEXITCODE
        }
        catch {
            $code     = 9001
            $captured = $_.Exception.Message
        }
        finally {
            $ErrorActionPreference = $prevEap
        }

        $outParts = @()
        $errParts = @()
        foreach ($item in @($captured)) {
            if ($null -eq $item) { continue }
            if ($item -is [System.Management.Automation.ErrorRecord]) {
                $errParts += $item.ToString()
            } else {
                $outParts += [string]$item
            }
        }
        $stdout = ($outParts -join "`n")
        $stderr = (($errParts -join "`n")).Trim()

        if ($code -eq 0) { return $stdout }

        $lines = @(
            "AWS CLI call FAILED on attempt $attempt of $Retries",
            "  what     : $label",
            "  command  : $cmdText",
            "  region   : $Region",
            "  exit code: $code",
            "  time     : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        )
        if ($stderr) { $lines += "  aws error: $stderr" }
        else         { $lines += '  aws error: (no stderr output - check credentials / network / pager)' }
        if ($stdout) { $lines += "  aws stdout: $(($stdout -join ' ').Trim())" }
        $detail = ($lines -join "`n")

        if ($attempt -lt $Retries) {
            Write-Warn "$label failed (exit $code); retrying in $DelaySeconds s (attempt $attempt/$Retries)..."
            if ($stderr) { Write-Host "    $stderr" -ForegroundColor DarkRed }
            Start-Sleep -Seconds $DelaySeconds
            continue
        }

        throw $detail
    }
}

# Read the DB instance object as a single normalized record, or $null if absent.
function Get-RdsInstance {
    $raw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What "describe-db-instances $RdsInstanceId" `
        rds describe-db-instances --db-instance-identifier $RdsInstanceId --output json
    $obj = $raw | ConvertFrom-Json
    if (-not $obj.DBInstances -or @($obj.DBInstances).Count -eq 0) { return $null }
    return @($obj.DBInstances)[0]
}

# Poll the instance until Status=available, or until the retry budget is spent.
# Returns the final instance object (caller decides success based on Status).
function Wait-ForRdsAvailable {
    param(
        [int]$MaxRetries = $MaxStatusRetries,
        [int]$DelaySeconds = $StatusDelaySeconds
    )
    for ($i = 1; $i -le $MaxRetries; $i++) {
        $inst = Get-RdsInstance
        if ($null -eq $inst) { Write-Warn 'describe-db-instances returned no instance; retrying.'; Start-Sleep -Seconds $DelaySeconds; continue }
        $status = $inst.DBInstanceStatus
        Write-Diag "poll $i/${MaxRetries}: status=$status  monitoringInterval=$($inst.MonitoringInterval)"
        if ($status -eq 'available') { return $inst }
        Start-Sleep -Seconds $DelaySeconds
    }
    return (Get-RdsInstance)
}
#endregion

# ------------------------------------------------------------------------------
# Failure trap: name the phase, show the underlying error, exit non-zero.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  ENABLE RDS ENHANCED MONITORING FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    Write-Host "  Time  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Red
    Write-Host '  Error :' -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
        Write-Host '  Where :' -ForegroundColor DarkRed
        foreach ($l in ($_.InvocationInfo.PositionMessage -split "`n")) { Write-Host "    $l" -ForegroundColor DarkRed }
    }
    Write-Host ''
    exit 1
}

# ==============================================================================
# PRE-FLIGHT
# ==============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity + DB instance checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No IAM or RDS changes will be made.'
} else {
    Write-Step 'LIVE MODE: this run will create/verify an IAM role and modify the RDS instance.'
}

Write-Step 'Checking AWS CLI is installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Step "AWS CLI: $awsVersion"

Write-Step 'Verifying AWS identity (OPERATOR identity)...'
$identity = Invoke-Aws sts get-caller-identity --output json | ConvertFrom-Json
Write-Step "Authenticated as: $($identity.Arn)"
if ($identity.Account -ne $AwsAccountId) {
    throw "Wrong AWS account: $($identity.Account) (expected $AwsAccountId)."
}

Write-Step "Confirming RDS instance '$RdsInstanceId' exists..."
$rds = Get-RdsInstance
if ($null -eq $rds) { throw "RDS instance '$RdsInstanceId' not found in $Region." }
$currentInterval = if ($rds.PSObject.Properties.Name -contains 'MonitoringInterval' -and $rds.MonitoringInterval) { [int]$rds.MonitoringInterval } else { 0 }
$currentRoleArn  = if ($rds.PSObject.Properties.Name -contains 'MonitoringRoleArn') { $rds.MonitoringRoleArn } else { $null }
Write-Diag "engine : $($rds.Engine) $($rds.EngineVersion)"
Write-Diag "status : $($rds.DBInstanceStatus)"
Write-Diag "current MonitoringInterval: $currentInterval  ($(if ($currentInterval -gt 0) {'enabled'} else {'disabled'}))"
Write-Diag "current MonitoringRoleArn : $(if ($currentRoleArn) {$currentRoleArn} else {'(none)'})"

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Ensure the IAM role 'rds-monitoring-role' exists
# ==============================================================================
# RDS assumes this role to ship OS metrics to CloudWatch Logs. It must trust the
# service principal monitoring.rds.amazonaws.com. IAM is global, so no region.
Write-Phase 'PHASE 1: Ensure the IAM monitoring role exists'

Write-Step "Checking whether IAM role '$MonitoringRoleName' already exists..."
$roleExists = $false
$MonitoringRoleArn = $null
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$getRoleOut = & aws iam get-role --role-name $MonitoringRoleName --output json 2>&1
$getRoleCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($getRoleCode -eq 0) {
    $roleObj = ($getRoleOut | Out-String | ConvertFrom-Json).Role
    $roleExists = $true
    $MonitoringRoleArn = $roleObj.Arn
    Write-Ok "Role already exists: $MonitoringRoleArn"
} else {
    $errText = ($getRoleOut | Out-String)
    if ($errText -notmatch 'NoSuchEntity') {
        throw "Unexpected error checking role '$MonitoringRoleName': $($errText.Trim())"
    }
    Write-Step "Role '$MonitoringRoleName' does not exist; it will be created."
}

if (-not $roleExists) {
    $trustPolicy = [ordered]@{
        Version   = '2012-10-17'
        Statement = @(
            [ordered]@{
                Sid       = 'AllowRdsMonitoringAssume'
                Effect    = 'Allow'
                Principal = [ordered]@{ Service = $MonitoringPrincipal }
                Action    = 'sts:AssumeRole'
            }
        )
    }
    $trustFile = Join-Path $ArtifactDir "rds-monitoring-trust-$Stamp.json"
    $trustPolicy | ConvertTo-Json -Depth 10 | Out-File -FilePath $trustFile -Encoding ascii
    Write-Step "Wrote trust policy to $trustFile"
    Write-Diag "trusts service principal: $MonitoringPrincipal"

    Confirm-Step "Create IAM role '$MonitoringRoleName' (trusts $MonitoringPrincipal)?"
    $created = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "iam create-role $MonitoringRoleName" `
        iam create-role --role-name $MonitoringRoleName `
        --assume-role-policy-document "file://$trustFile" `
        --description 'Allows RDS Enhanced Monitoring to publish OS metrics to CloudWatch Logs' `
        --output json
    if ($DryRun) {
        $MonitoringRoleArn = "arn:aws:iam::${AwsAccountId}:role/$MonitoringRoleName"
        Write-Ok "[DRY-RUN] would create role; assuming ARN $MonitoringRoleArn for the plan."
    } else {
        $MonitoringRoleArn = ($created | ConvertFrom-Json).Role.Arn
        Write-Ok "Created role: $MonitoringRoleArn"
        # New IAM roles can take a moment to be assumable; give RDS a few seconds.
        Write-Step 'Waiting briefly for IAM role propagation...'
        Start-Sleep -Seconds 10
    }
}
if ([string]::IsNullOrEmpty($MonitoringRoleArn)) {
    $MonitoringRoleArn = "arn:aws:iam::${AwsAccountId}:role/$MonitoringRoleName"
}

# ==============================================================================
# PHASE 2 - Attach the managed policy 'AmazonRDSEnhancedMonitoringRole'
# ==============================================================================
# attach-role-policy is idempotent: attaching an already-attached policy is a
# no-op (no error), so we can call it unconditionally - but we check first for a
# clean, informative log.
Write-Phase 'PHASE 2: Attach the AmazonRDSEnhancedMonitoringRole managed policy'

$alreadyAttached = $false
if ($roleExists -or -not $DryRun) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $attListOut = & aws iam list-attached-role-policies --role-name $MonitoringRoleName --output json 2>&1
    $attListCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($attListCode -eq 0) {
        $attached = @((($attListOut | Out-String | ConvertFrom-Json).AttachedPolicies) | ForEach-Object { $_.PolicyArn })
        if ($attached -contains $ManagedPolicyArn) { $alreadyAttached = $true }
    }
}

if ($alreadyAttached) {
    Write-Ok "Managed policy already attached to '$MonitoringRoleName'. Skipping."
} else {
    Confirm-Step "Attach managed policy AmazonRDSEnhancedMonitoringRole to '$MonitoringRoleName'?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'iam attach-role-policy' `
        iam attach-role-policy --role-name $MonitoringRoleName --policy-arn $ManagedPolicyArn | Out-Null
    Write-Ok "Attached $ManagedPolicyArn to '$MonitoringRoleName'."
}

# ==============================================================================
# PHASE 3 - Enable enhanced monitoring on the DB instance
# ==============================================================================
Write-Phase 'PHASE 3: Modify the DB instance to enable enhanced monitoring'

$alreadyEnabled = ($currentInterval -eq $MonitoringInterval) -and `
                  ($currentRoleArn -eq $MonitoringRoleArn)

if ($alreadyEnabled) {
    Write-Ok "Enhanced monitoring already enabled (interval=$currentInterval, role=$currentRoleArn). No modify needed."
} else {
    Write-Step 'Target monitoring settings:'
    Write-Diag "MonitoringInterval = $MonitoringInterval (seconds)"
    Write-Diag "MonitoringRoleArn  = $MonitoringRoleArn"
    Write-Diag "ApplyImmediately   = true (no reboot required for this change)"

    Confirm-Step "Enable enhanced monitoring (interval ${MonitoringInterval}s) on RDS '$RdsInstanceId' now?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "rds modify-db-instance $RdsInstanceId" `
        rds modify-db-instance --db-instance-identifier $RdsInstanceId `
        --monitoring-interval $MonitoringInterval `
        --monitoring-role-arn $MonitoringRoleArn `
        --apply-immediately | Out-Null
    Write-Ok "modify-db-instance submitted (monitoring interval ${MonitoringInterval}s, applied immediately)."
}

# ==============================================================================
# PHASE 4 - Wait for the instance to return to 'available'
# ==============================================================================
Write-Phase 'PHASE 4: Wait for the DB instance to become available'

if ($DryRun) {
    Write-Ok '[DRY-RUN] would poll the DB instance until Status=available.'
} elseif ($alreadyEnabled) {
    Write-Ok 'No modify was made; skipping the availability wait.'
} else {
    Write-Step "Polling RDS status until available (max $MaxStatusRetries x ${StatusDelaySeconds}s)..."
    # Give RDS a moment to transition into 'modifying' before we start polling.
    Start-Sleep -Seconds 5
    $inst = Wait-ForRdsAvailable
    if ($null -eq $inst -or $inst.DBInstanceStatus -ne 'available') {
        $st = if ($inst) { $inst.DBInstanceStatus } else { '(unknown)' }
        throw "DB instance did not return to 'available' within the retry budget (status=$st)."
    }
    Write-Ok "DB instance is available."
}

# ==============================================================================
# PHASE 5 - Verify monitoring is enabled + show the CloudWatch endpoint
# ==============================================================================
Write-Phase 'PHASE 5: Verify enhanced monitoring and show CloudWatch metrics'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: role/policy/modify plan validated. No changes were made.'
    Write-Warn 'Re-run without -DryRun to create the role, attach the policy, and enable monitoring.'
    Write-Host ''
    Write-Host '  Planned changes:' -ForegroundColor Yellow
    Write-Host "    iam role        : $MonitoringRoleName ($MonitoringRoleArn)" -ForegroundColor DarkGray
    Write-Host "    managed policy  : $ManagedPolicyArn" -ForegroundColor DarkGray
    Write-Host "    rds instance    : $RdsInstanceId -> MonitoringInterval=$MonitoringInterval" -ForegroundColor DarkGray
    Write-Host ''
    return
}

$final = Get-RdsInstance
if ($null -eq $final) { throw "Could not re-read RDS instance '$RdsInstanceId' for verification." }
$finalInterval = if ($final.PSObject.Properties.Name -contains 'MonitoringInterval' -and $final.MonitoringInterval) { [int]$final.MonitoringInterval } else { 0 }
$finalRoleArn  = if ($final.PSObject.Properties.Name -contains 'MonitoringRoleArn') { $final.MonitoringRoleArn } else { $null }
$dbResourceId  = $final.DbiResourceId
Write-Diag "MonitoringInterval: $finalInterval"
Write-Diag "MonitoringRoleArn : $(if ($finalRoleArn) {$finalRoleArn} else {'(none)'})"

if ($finalInterval -ne $MonitoringInterval) {
    throw "Verification failed: MonitoringInterval is $finalInterval, expected $MonitoringInterval."
}
Write-Ok "Enhanced monitoring is ON (interval ${finalInterval}s)."

# Enhanced-monitoring OS metrics are delivered to the CloudWatch Logs group
# 'RDSOSMetrics' under a log stream named after the instance's resource id.
Write-Step 'CloudWatch enhanced-monitoring data:'
Write-Diag "log group  : $OsMetricsLogGroup"
if ($dbResourceId) { Write-Diag "log stream : $dbResourceId" }
$cwLogsUrl = "https://${Region}.console.aws.amazon.com/cloudwatch/home?region=${Region}#logsV2:log-groups/log-group/$OsMetricsLogGroup"
$rdsMonUrl = "https://${Region}.console.aws.amazon.com/rds/home?region=${Region}#database:id=$RdsInstanceId;is-cluster=false;tab=monitoring"
Write-Diag "OS metrics : $cwLogsUrl"
Write-Diag "RDS console: $rdsMonUrl"

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: RDS Enhanced Monitoring enabled and verified' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  db instance   : $RdsInstanceId" -ForegroundColor Green
Write-Host "  interval      : ${finalInterval}s" -ForegroundColor Green
Write-Host "  monitoring role: $finalRoleArn" -ForegroundColor Green
Write-Host "  log group     : $OsMetricsLogGroup$(if ($dbResourceId) { " (stream: $dbResourceId)" })" -ForegroundColor Green
Write-Host ''
Write-Host '  View OS metrics live:' -ForegroundColor Yellow
if ($dbResourceId) {
    Write-Host "    aws logs tail $OsMetricsLogGroup --log-stream-names $dbResourceId --region $Region --follow" -ForegroundColor DarkGray
} else {
    Write-Host "    aws logs tail $OsMetricsLogGroup --region $Region --follow" -ForegroundColor DarkGray
}
Write-Host "    $rdsMonUrl" -ForegroundColor DarkGray
Write-Host ''
Write-Ok 'RDS enhanced monitoring is active.'
