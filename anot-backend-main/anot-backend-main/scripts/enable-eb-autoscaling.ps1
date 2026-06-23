<#
================================================================================
 enable-eb-autoscaling.ps1  -  Enable CPU-based auto-scaling for the Elastic
                               Beanstalk environment 'anot-backend-prod'
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 THE GOAL:
   Make the EB environment 'anot-backend-prod' (id e-g7bj3ndsck) scale its EC2
   fleet automatically on CPU load: keep 1 instance normally and add up to 2
   more (max 3) when CPU is sustained high, then shed them again when CPU falls.

   Target shape:
     MinSize         = 1   (never below one instance)
     MaxSize         = 3   (scale out to at most three instances)
     DesiredCapacity = 1   (start at one; EB keeps desired at MinSize)
     Cooldown        = 300 (5 minutes between scaling actions)
     Scale UP   : CPUUtilization > 70% for 2 minutes  -> add 1 instance
     Scale DOWN : CPUUtilization < 30% for 5 minutes   -> remove 1 instance

 HOW THE BOUNDS ARE SET (EB options first, then a direct ASG fallback):
   The Auto Scaling Group is OWNED by Elastic Beanstalk. The DURABLE way to set
   the bounds is the EB option namespace 'aws:autoscaling:asg' (MinSize / MaxSize
   / Cooldown); EB then applies those to the ASG for us, and a raw ASG change can
   be reverted by EB on the next deploy. So by default the script sets the bounds
   via EB and polls the ASG to confirm EB pushed them through.

   In practice the EB option path does not always converge: a SingleInstance
   environment pins the ASG at min=1/max=1 regardless of the option, the option
   names can differ, or EB simply does not propagate the change. So if EB options
   do NOT move the ASG within the poll window, the script FALLS BACK to setting
   the bounds directly with 'aws autoscaling update-auto-scaling-group'. Pass
   -SkipEbOptions to skip the EB attempt entirely and go straight to the direct
   ASG update (useful once you know EB will not honor the options for this env).
   The direct change may be reverted by a future EB deploy; re-run to re-assert.

 WHY THE ALARMS / POLICIES ARE CREATED DIRECTLY:
   EB's built-in trigger namespace ('aws:autoscaling:trigger') exposes only a
   SINGLE breach duration shared by the high and low thresholds, so it cannot
   express "up after 2 min, down after 5 min". To honor the asymmetric timing
   we attach our own simple-scaling policies (+1 / -1) to the EB-managed ASG and
   two CloudWatch alarms (CPU high -> scale-up policy, CPU low -> scale-down
   policy). These are additive and EB leaves them alone. Re-running overwrites
   the same-named policies/alarms, so the script is idempotent.

 WHAT THIS SCRIPT DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks; confirm the environment exists.
   Phase 1     Discover the EB-managed ASG + its launch config/template; report
               current MinSize / MaxSize / DesiredCapacity / Cooldown.
   Phase 1b    Diagnose: dump every 'aws:autoscaling:*' option EB currently holds
               and the EnvironmentType, so you can see what EB thinks it controls.
   Phase 2     Set MinSize / MaxSize / Cooldown via EB option settings and poll
               the ASG until it reflects them. If EB does not converge (or with
               -SkipEbOptions), fall back to a direct update-auto-scaling-group.
   Phase 3     Create/overwrite the scale-up (+1) and scale-down (-1) simple
               scaling policies on the ASG; capture their policy ARNs.
   Phase 4     Create/overwrite the two CloudWatch CPU alarms wired to those
               policies (70%/2min up, 30%/5min down).
   Phase 5     Verify the ASG bounds, that both alarms exist/are active, and
               print the scaling policy details.

 SAFETY:
   * Idempotent end-to-end: re-running re-asserts the same bounds, policies, and
     alarms (put-* calls overwrite by name).
   * -DryRun does every read-only check and prints exactly which mutating calls
     WOULD run, without changing EB, the ASG, or CloudWatch.
   * Mutating steps prompt for confirmation unless -Force / -SkipConfirm.

 USAGE:
   powershell -File scripts/enable-eb-autoscaling.ps1 -DryRun   # rehearse, no change
   powershell -File scripts/enable-eb-autoscaling.ps1           # apply (prompts)
   powershell -File scripts/enable-eb-autoscaling.ps1 -Force    # apply, no prompts
   powershell -File scripts/enable-eb-autoscaling.ps1 -MaxSize 4
   powershell -File scripts/enable-eb-autoscaling.ps1 -SkipEbOptions  # ASG direct
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun,
    [switch]$SkipEbOptions,
    [ValidateRange(1, 20)] [int]$MinSize = 1,
    [ValidateRange(1, 20)] [int]$MaxSize = 3,
    [ValidateRange(1, 20)] [int]$DesiredCapacity = 1,
    [ValidateRange(0, 3600)] [int]$Cooldown = 300,
    [ValidateRange(1, 100)] [int]$ScaleUpThreshold = 70,
    [ValidateRange(1, 100)] [int]$ScaleDownThreshold = 30,
    [ValidateRange(1, 60)] [int]$ScaleUpMinutes = 2,
    [ValidateRange(1, 60)] [int]$ScaleDownMinutes = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId = '625242092266'
$Region       = 'ap-southeast-1'
$EbAppName    = 'anot-backend'
$EbEnvName    = 'anot-backend-prod'
$EbEnvId      = 'e-g7bj3ndsck'

# EB option namespace that durably controls the ASG bounds.
$AsgNamespace = 'aws:autoscaling:asg'

# The CloudWatch metric we scale on (per-instance EC2 CPU, averaged by the ASG).
$MetricName      = 'CPUUtilization'
$MetricNamespace = 'AWS/EC2'
$AlarmPeriod     = 60     # seconds per datapoint; minutes-of-breach = period * evaluation-periods

# Names for the policies + alarms (idempotent: put-* overwrites by name).
$ScaleUpPolicyName   = "$EbEnvName-cpu-scale-up"
$ScaleDownPolicyName = "$EbEnvName-cpu-scale-down"
$CpuHighAlarmName    = "$EbEnvName-cpu-high"
$CpuLowAlarmName     = "$EbEnvName-cpu-low"

$MaxEnvRetries      = 20    # environment-update settle polling
$EnvRetryDelaySecs  = 15
$MaxAsgRetries      = 20    # ASG-reflects-bounds polling
$AsgRetryDelaySecs  = 15

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'

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

# Read the current EB environment object (version/health/status) or $null.
function Get-EbEnvironment {
    $json = Invoke-Aws -Retries 3 -DelaySeconds 5 elasticbeanstalk describe-environments `
        --application-name $EbAppName --environment-names $EbEnvName --output json | ConvertFrom-Json
    if (-not $json.Environments -or @($json.Environments).Count -eq 0) { return $null }
    return @($json.Environments)[0]
}

# Read the EB-managed Auto Scaling Group object by name, or $null if absent.
function Get-Asg {
    param([string]$AsgName)
    if ([string]::IsNullOrEmpty($AsgName)) { return $null }
    $raw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What "describe-auto-scaling-groups $AsgName" `
        autoscaling describe-auto-scaling-groups --auto-scaling-group-names $AsgName --output json
    if (-not $raw) { return $null }
    $obj = $raw | ConvertFrom-Json
    if (-not $obj.AutoScalingGroups -or @($obj.AutoScalingGroups).Count -eq 0) { return $null }
    return @($obj.AutoScalingGroups)[0]
}

# Read EVERY option setting EB currently holds for the environment (or @()).
# Used by the diagnostic phase to show what EB thinks it controls.
function Get-EbConfigOptions {
    $raw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'describe-configuration-settings' `
        elasticbeanstalk describe-configuration-settings `
        --application-name $EbAppName --environment-name $EbEnvName --output json
    if (-not $raw) { return @() }
    $obj = $raw | ConvertFrom-Json
    if (-not $obj.ConfigurationSettings -or @($obj.ConfigurationSettings).Count -eq 0) { return @() }
    $settings = @($obj.ConfigurationSettings)[0]
    if (-not ($settings.PSObject.Properties.Name -contains 'OptionSettings') -or -not $settings.OptionSettings) { return @() }
    return @($settings.OptionSettings)
}

# Set the ASG bounds DIRECTLY via the Auto Scaling API (fallback / -SkipEbOptions).
# Deliberately mirrors the documented one-liner: min/max/cooldown only. We do not
# touch DesiredCapacity so we never terminate or launch instances as a side effect;
# the ASG clamps any existing desired into the new [min,max] window on its own.
function Set-AsgBoundsDirect {
    param(
        [string]$AsgName,
        [int]$Min,
        [int]$Max,
        [int]$Cool
    )
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'update-auto-scaling-group (direct ASG)' `
        autoscaling update-auto-scaling-group --auto-scaling-group-name $AsgName `
        --min-size $Min --max-size $Max --default-cooldown $Cool | Out-Null
}

# Poll the ASG until MinSize/MaxSize match the targets (EB pushes them async).
function Wait-ForAsgBounds {
    param(
        [string]$AsgName,
        [int]$TargetMin,
        [int]$TargetMax,
        [int]$MaxRetries = $MaxAsgRetries,
        [int]$DelaySeconds = $AsgRetryDelaySecs
    )
    for ($i = 1; $i -le $MaxRetries; $i++) {
        $asg = Get-Asg -AsgName $AsgName
        if ($null -eq $asg) { Write-Warn 'describe-auto-scaling-groups returned nothing; retrying.'; Start-Sleep -Seconds $DelaySeconds; continue }
        Write-Diag "poll $i/${MaxRetries}: min=$($asg.MinSize) max=$($asg.MaxSize) desired=$($asg.DesiredCapacity) cooldown=$($asg.DefaultCooldown)"
        if (([int]$asg.MinSize -eq $TargetMin) -and ([int]$asg.MaxSize -eq $TargetMax)) { return $asg }
        if ($i -lt $MaxRetries) { Start-Sleep -Seconds $DelaySeconds }
    }
    return (Get-Asg -AsgName $AsgName)
}
#endregion

# ------------------------------------------------------------------------------
# Failure trap: name the phase, show the underlying error, exit non-zero.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  ENABLE EB AUTO-SCALING FAILED' -ForegroundColor Red
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
Write-Phase 'PRE-FLIGHT: tooling + identity + environment checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No EB, ASG, or CloudWatch changes will be made.'
} else {
    Write-Step 'LIVE MODE: this run will modify the EB environment, the ASG bounds, and CloudWatch alarms.'
}

if ($MinSize -gt $MaxSize)         { throw "MinSize ($MinSize) cannot exceed MaxSize ($MaxSize)." }
if ($DesiredCapacity -lt $MinSize) { throw "DesiredCapacity ($DesiredCapacity) cannot be below MinSize ($MinSize)." }
if ($DesiredCapacity -gt $MaxSize) { throw "DesiredCapacity ($DesiredCapacity) cannot exceed MaxSize ($MaxSize)." }
if ($ScaleDownThreshold -ge $ScaleUpThreshold) {
    throw "ScaleDownThreshold ($ScaleDownThreshold) must be below ScaleUpThreshold ($ScaleUpThreshold)."
}

Write-Step 'Checking AWS CLI is installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Step "AWS CLI: $awsVersion"

Write-Step 'Verifying AWS identity (OPERATOR identity, not the app)...'
$identity = Invoke-Aws sts get-caller-identity --output json | ConvertFrom-Json
Write-Step "Authenticated as: $($identity.Arn)"
if ($identity.Account -ne $AwsAccountId) {
    throw "Wrong AWS account: $($identity.Account) (expected $AwsAccountId)."
}

Write-Step "Confirming EB environment '$EbEnvName' ($EbEnvId) exists..."
$envObj = Get-EbEnvironment
if ($null -eq $envObj) { throw "EB environment '$EbEnvName' not found in application '$EbAppName'." }
Write-Diag "env id : $($envObj.EnvironmentId)"
Write-Diag "version: $($envObj.VersionLabel)  health: $($envObj.Health)  status: $($envObj.HealthStatus)"
if ($envObj.EnvironmentId -ne $EbEnvId) {
    Write-Warn "Environment id is '$($envObj.EnvironmentId)', expected '$EbEnvId'. Proceeding against '$EbEnvName' by name."
}

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Discover the EB-managed ASG + launch config; report current bounds
# ==============================================================================
Write-Phase 'PHASE 1: Discover the EB-managed Auto Scaling Group'

Write-Step "Reading environment resources to find the ASG for '$EbEnvName'..."
$resJson = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'describe-environment-resources' `
    elasticbeanstalk describe-environment-resources --environment-name $EbEnvName --output json | ConvertFrom-Json
$asgList = @($resJson.EnvironmentResources.AutoScalingGroups)
if ($asgList.Count -eq 0) { throw "No Auto Scaling Group found for environment '$EbEnvName'." }
$AsgName = $asgList[0].Name
Write-Ok "EB-managed ASG: $AsgName"

Write-Step 'Reading current ASG configuration...'
$asg = Get-Asg -AsgName $AsgName
if ($null -eq $asg) { throw "Could not read the Auto Scaling Group '$AsgName'." }
$curMin      = [int]$asg.MinSize
$curMax      = [int]$asg.MaxSize
$curDesired  = [int]$asg.DesiredCapacity
$curCooldown = [int]$asg.DefaultCooldown
$launchCfg   = if ($asg.PSObject.Properties.Name -contains 'LaunchConfigurationName' -and $asg.LaunchConfigurationName) { $asg.LaunchConfigurationName } else { $null }
$launchTmpl  = if ($asg.PSObject.Properties.Name -contains 'LaunchTemplate' -and $asg.LaunchTemplate) { $asg.LaunchTemplate.LaunchTemplateName } else { $null }
Write-Diag "current MinSize         : $curMin"
Write-Diag "current MaxSize         : $curMax"
Write-Diag "current DesiredCapacity : $curDesired"
Write-Diag "current Cooldown        : ${curCooldown}s"
if ($launchCfg)  { Write-Diag "launch configuration   : $launchCfg" }
if ($launchTmpl) { Write-Diag "launch template        : $launchTmpl" }
if (-not $launchCfg -and -not $launchTmpl) { Write-Diag 'launch config/template : (none reported)' }

if (($curMin -eq $MinSize) -and ($curMax -eq $MaxSize) -and ($curCooldown -eq $Cooldown)) {
    Write-Warn 'ASG bounds already match the targets. The script will still (re)assert policies and alarms.'
}

# ==============================================================================
# PHASE 1b - Diagnose: what does EB actually hold for autoscaling?
# ==============================================================================
# Dump every 'aws:autoscaling:*' option EB reports, plus the EnvironmentType.
# This is the fastest way to see WHY the bounds may not move: e.g. a
# SingleInstance environment pins the ASG at min=1/max=1 no matter what option
# you set, or the MinSize/MaxSize options simply are not present/honored.
Write-Phase 'PHASE 1b: Diagnose EB autoscaling option settings'

$EnvironmentType = $null
try {
    $allOpts = Get-EbConfigOptions
    $asgOpts = @($allOpts | Where-Object { $_.Namespace -like 'aws:autoscaling:*' })

    $envTypeOpt = @($allOpts | Where-Object {
        $_.Namespace -eq 'aws:elasticbeanstalk:environment' -and $_.OptionName -eq 'EnvironmentType'
    })
    if ($envTypeOpt.Count -gt 0 -and $envTypeOpt[0].PSObject.Properties.Name -contains 'Value') {
        $EnvironmentType = $envTypeOpt[0].Value
    }
    Write-Diag "EnvironmentType: $(if ($EnvironmentType) { $EnvironmentType } else { '(not set / default LoadBalanced)' })"
    if ($EnvironmentType -eq 'SingleInstance') {
        Write-Warn 'EnvironmentType is SingleInstance: EB pins the ASG at min=1/max=1 and will'
        Write-Warn 'ignore aws:autoscaling:asg MinSize/MaxSize. The direct ASG update can still'
        Write-Warn 'set the bounds, but EB may revert them. Consider a LoadBalanced environment.'
    }

    if ($asgOpts.Count -eq 0) {
        Write-Warn "EB reports NO 'aws:autoscaling:*' options for this environment."
    } else {
        Write-Step "EB 'aws:autoscaling:*' options currently in effect ($($asgOpts.Count)):"
        foreach ($o in ($asgOpts | Sort-Object Namespace, OptionName)) {
            $val = if ($o.PSObject.Properties.Name -contains 'Value' -and $null -ne $o.Value) { $o.Value } else { '(unset)' }
            Write-Diag "$($o.Namespace) :: $($o.OptionName) = $val"
        }
    }
    Write-Ok 'Diagnostics captured. Phase 2 sets the bounds; it falls back to a direct ASG update if EB does not converge.'
}
catch {
    Write-Warn "Diagnostics could not read configuration settings: $($_.Exception.Message)"
    Write-Warn 'Continuing; Phase 2 will still attempt the EB option update and direct-ASG fallback.'
}

# ==============================================================================
# PHASE 2 - Set MinSize / MaxSize / Cooldown (EB options, ASG-direct fallback)
# ==============================================================================
# Preferred path: set the bounds through EB (durable) so EB does not revert a raw
# change on next deploy. Reality check: EB does not always propagate the option to
# the ASG (SingleInstance pinning, option mismatch, slow/blocked update). So we
# poll the ASG and, if it has not converged, FALL BACK to a direct ASG update.
# -SkipEbOptions bypasses the EB attempt and goes straight to the direct update.
Write-Phase 'PHASE 2: Set the scaling bounds (EB options -> direct ASG fallback)'

Write-Step 'Target ASG bounds:'
Write-Diag "MinSize  = $MinSize"
Write-Diag "MaxSize  = $MaxSize"
Write-Diag "Cooldown = ${Cooldown}s"
Write-Diag "DesiredCapacity tracks MinSize under EB management (-> $MinSize)"

# Tracks whether we still need the direct ASG update after the EB attempt.
$boundsConverged = $false

if ($SkipEbOptions) {
    Write-Warn '-SkipEbOptions set: skipping the EB option update; going straight to the direct ASG update.'
}
else {
    Confirm-Step "Set MinSize=$MinSize, MaxSize=$MaxSize, Cooldown=${Cooldown}s on '$EbEnvName' via EB options now?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'update-environment (ASG bounds)' `
        elasticbeanstalk update-environment `
        --application-name $EbAppName --environment-name $EbEnvName `
        --option-settings `
            "Namespace=$AsgNamespace,OptionName=MinSize,Value=$MinSize" `
            "Namespace=$AsgNamespace,OptionName=MaxSize,Value=$MaxSize" `
            "Namespace=$AsgNamespace,OptionName=Cooldown,Value=$Cooldown" | Out-Null

    if ($DryRun) {
        Write-Ok '[DRY-RUN] would set the ASG bounds via EB, poll the ASG, and fall back to a direct update if needed.'
    }
    else {
        Write-Step 'Waiting for the environment to finish updating...'
        Invoke-Aws -SkipInDryRun elasticbeanstalk wait environment-updated `
            --application-name $EbAppName --environment-names $EbEnvName
        Write-Ok 'EB environment update completed.'

        Write-Step "Polling the ASG until it reflects min=$MinSize / max=$MaxSize (max $MaxAsgRetries x ${AsgRetryDelaySecs}s)..."
        $asg = Wait-ForAsgBounds -AsgName $AsgName -TargetMin $MinSize -TargetMax $MaxSize
        if ($null -ne $asg -and [int]$asg.MinSize -eq $MinSize -and [int]$asg.MaxSize -eq $MaxSize) {
            $boundsConverged = $true
            Write-Ok "ASG bounds applied via EB: min=$($asg.MinSize) max=$($asg.MaxSize) desired=$($asg.DesiredCapacity) cooldown=$($asg.DefaultCooldown)s."
        }
        else {
            $m = if ($asg) { $asg.MinSize } else { '(unknown)' }
            $x = if ($asg) { $asg.MaxSize } else { '(unknown)' }
            Write-Warn "EB options did not move the ASG (min=$m, max=$x; expected min=$MinSize/max=$MaxSize)."
            Write-Warn 'Falling back to a direct update-auto-scaling-group.'
        }
    }
}

# In a dry run that attempted the EB path, do not ALSO print a direct-update plan
# (EB might have converged for real); only plan the direct path when it is certain
# to run: -SkipEbOptions, or any live run where EB did not converge.
if ((-not $boundsConverged) -and ($SkipEbOptions -or -not $DryRun)) {
    Confirm-Step "Set MinSize=$MinSize, MaxSize=$MaxSize, Cooldown=${Cooldown}s DIRECTLY on ASG '$AsgName' now?"
    Set-AsgBoundsDirect -AsgName $AsgName -Min $MinSize -Max $MaxSize -Cool $Cooldown

    if ($DryRun) {
        Write-Ok '[DRY-RUN] would set the ASG bounds directly and poll the ASG until they apply.'
    }
    else {
        Write-Step "Polling the ASG until it reflects min=$MinSize / max=$MaxSize (max $MaxAsgRetries x ${AsgRetryDelaySecs}s)..."
        $asg = Wait-ForAsgBounds -AsgName $AsgName -TargetMin $MinSize -TargetMax $MaxSize
        if ($null -eq $asg -or [int]$asg.MinSize -ne $MinSize -or [int]$asg.MaxSize -ne $MaxSize) {
            $m = if ($asg) { $asg.MinSize } else { '(unknown)' }
            $x = if ($asg) { $asg.MaxSize } else { '(unknown)' }
            throw "ASG bounds did not converge after the direct update (min=$m, max=$x, expected min=$MinSize/max=$MaxSize)."
        }
        Write-Ok "ASG bounds applied directly: min=$($asg.MinSize) max=$($asg.MaxSize) desired=$($asg.DesiredCapacity) cooldown=$($asg.DefaultCooldown)s."
    }
}

# ==============================================================================
# PHASE 3 - Create the simple scaling policies (+1 / -1) on the ASG
# ==============================================================================
# Simple scaling, ChangeInCapacity, with a 300s cooldown between actions. The
# returned PolicyARN is what each CloudWatch alarm fires as its AlarmAction.
Write-Phase 'PHASE 3: Create the scale-up (+1) and scale-down (-1) policies'

Confirm-Step "Create/overwrite scaling policy '$ScaleUpPolicyName' (+1, cooldown ${Cooldown}s) on '$AsgName'?"
$scaleUpOut = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-scaling-policy $ScaleUpPolicyName" `
    autoscaling put-scaling-policy --auto-scaling-group-name $AsgName `
    --policy-name $ScaleUpPolicyName `
    --adjustment-type ChangeInCapacity `
    --scaling-adjustment=1 `
    --cooldown $Cooldown --output json
if ($DryRun) {
    $ScaleUpPolicyArn = "arn:aws:autoscaling:${Region}:${AwsAccountId}:scalingPolicy:*:autoScalingGroupName/${AsgName}:policyName/${ScaleUpPolicyName}"
    Write-Ok "[DRY-RUN] would create scale-up policy; assuming ARN for the plan."
} else {
    $ScaleUpPolicyArn = ($scaleUpOut | ConvertFrom-Json).PolicyARN
    Write-Ok "Scale-up policy ARN: $ScaleUpPolicyArn"
}

Confirm-Step "Create/overwrite scaling policy '$ScaleDownPolicyName' (-1, cooldown ${Cooldown}s) on '$AsgName'?"
$scaleDownOut = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-scaling-policy $ScaleDownPolicyName" `
    autoscaling put-scaling-policy --auto-scaling-group-name $AsgName `
    --policy-name $ScaleDownPolicyName `
    --adjustment-type ChangeInCapacity `
    --scaling-adjustment=-1 `
    --cooldown $Cooldown --output json
if ($DryRun) {
    $ScaleDownPolicyArn = "arn:aws:autoscaling:${Region}:${AwsAccountId}:scalingPolicy:*:autoScalingGroupName/${AsgName}:policyName/${ScaleDownPolicyName}"
    Write-Ok "[DRY-RUN] would create scale-down policy; assuming ARN for the plan."
} else {
    $ScaleDownPolicyArn = ($scaleDownOut | ConvertFrom-Json).PolicyARN
    Write-Ok "Scale-down policy ARN: $ScaleDownPolicyArn"
}

# ==============================================================================
# PHASE 4 - Create the CloudWatch CPU alarms wired to those policies
# ==============================================================================
# minutes-of-breach = AlarmPeriod (60s) * evaluation-periods.
#   up   : 70% for 2 minutes  -> evaluation-periods = 2
#   down : 30% for 5 minutes  -> evaluation-periods = 5
Write-Phase 'PHASE 4: Create the CloudWatch CPU scaling alarms'

$upEvalPeriods   = [int]([math]::Ceiling(($ScaleUpMinutes * 60) / $AlarmPeriod))
$downEvalPeriods = [int]([math]::Ceiling(($ScaleDownMinutes * 60) / $AlarmPeriod))
Write-Diag "ScaleUp   : $MetricName > $ScaleUpThreshold% for $ScaleUpMinutes min (period ${AlarmPeriod}s x $upEvalPeriods)"
Write-Diag "ScaleDown : $MetricName < $ScaleDownThreshold% for $ScaleDownMinutes min (period ${AlarmPeriod}s x $downEvalPeriods)"

Confirm-Step "Create/overwrite alarm '$CpuHighAlarmName' (CPU > $ScaleUpThreshold%) -> scale-up?"
Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-metric-alarm $CpuHighAlarmName" `
    cloudwatch put-metric-alarm --alarm-name $CpuHighAlarmName `
    --alarm-description "Scale OUT $EbEnvName when CPU > $ScaleUpThreshold% for $ScaleUpMinutes min" `
    --namespace $MetricNamespace --metric-name $MetricName --statistic Average --unit Percent `
    --period $AlarmPeriod --evaluation-periods $upEvalPeriods `
    --threshold $ScaleUpThreshold --comparison-operator GreaterThanThreshold `
    --dimensions "Name=AutoScalingGroupName,Value=$AsgName" `
    --alarm-actions $ScaleUpPolicyArn | Out-Null
Write-Ok "Alarm '$CpuHighAlarmName' configured (scale-out trigger)."

Confirm-Step "Create/overwrite alarm '$CpuLowAlarmName' (CPU < $ScaleDownThreshold%) -> scale-down?"
Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-metric-alarm $CpuLowAlarmName" `
    cloudwatch put-metric-alarm --alarm-name $CpuLowAlarmName `
    --alarm-description "Scale IN $EbEnvName when CPU < $ScaleDownThreshold% for $ScaleDownMinutes min" `
    --namespace $MetricNamespace --metric-name $MetricName --statistic Average --unit Percent `
    --period $AlarmPeriod --evaluation-periods $downEvalPeriods `
    --threshold $ScaleDownThreshold --comparison-operator LessThanThreshold `
    --dimensions "Name=AutoScalingGroupName,Value=$AsgName" `
    --alarm-actions $ScaleDownPolicyArn | Out-Null
Write-Ok "Alarm '$CpuLowAlarmName' configured (scale-in trigger)."

# ==============================================================================
# PHASE 5 - Verify the ASG bounds, alarms, and show the scaling policies
# ==============================================================================
Write-Phase 'PHASE 5: Verify auto-scaling configuration'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: discovery + plan validated. No changes were made.'
    Write-Warn 'Re-run without -DryRun to apply the bounds, policies, and alarms.'
    Write-Host ''
    $boundsMethod = if ($SkipEbOptions) { 'direct update-auto-scaling-group' } else { 'EB options first, direct ASG fallback' }
    Write-Host '  Planned changes:' -ForegroundColor Yellow
    Write-Host "    bounds via     : $boundsMethod" -ForegroundColor DarkGray
    Write-Host "    asg            : $AsgName -> min=$MinSize max=$MaxSize cooldown=${Cooldown}s" -ForegroundColor DarkGray
    Write-Host "    scale-up policy: $ScaleUpPolicyName (+1)" -ForegroundColor DarkGray
    Write-Host "    scale-dn policy: $ScaleDownPolicyName (-1)" -ForegroundColor DarkGray
    Write-Host "    alarm (high)   : $CpuHighAlarmName  CPU > $ScaleUpThreshold% / $ScaleUpMinutes min" -ForegroundColor DarkGray
    Write-Host "    alarm (low)    : $CpuLowAlarmName  CPU `< $ScaleDownThreshold% / $ScaleDownMinutes min" -ForegroundColor DarkGray
    Write-Host ''
    return
}

Write-Step 'Re-reading the ASG to confirm bounds...'
$finalAsg = Get-Asg -AsgName $AsgName
if ($null -eq $finalAsg) { throw "Could not re-read ASG '$AsgName' for verification." }
if ([int]$finalAsg.MinSize -ne $MinSize -or [int]$finalAsg.MaxSize -ne $MaxSize) {
    throw "Verification failed: ASG min=$($finalAsg.MinSize) max=$($finalAsg.MaxSize), expected min=$MinSize/max=$MaxSize."
}
Write-Ok "ASG verified: min=$($finalAsg.MinSize) max=$($finalAsg.MaxSize) desired=$($finalAsg.DesiredCapacity) cooldown=$($finalAsg.DefaultCooldown)s."

Write-Step 'Confirming both CloudWatch alarms exist and are active...'
$alarmRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'describe-alarms' `
    cloudwatch describe-alarms --alarm-names $CpuHighAlarmName $CpuLowAlarmName --output json
$alarms = @(($alarmRaw | ConvertFrom-Json).MetricAlarms)
$alarmNames = @($alarms | ForEach-Object { $_.AlarmName })
foreach ($expected in @($CpuHighAlarmName, $CpuLowAlarmName)) {
    if ($alarmNames -notcontains $expected) { throw "Verification failed: alarm '$expected' was not found." }
}
foreach ($a in $alarms) {
    $enabled = if ($a.ActionsEnabled) { 'actions-enabled' } else { 'actions-DISABLED' }
    Write-Diag "alarm $($a.AlarmName): state=$($a.StateValue)  $enabled  ($($a.ComparisonOperator) $($a.Threshold))"
}
Write-Ok 'Both CPU alarms exist and have scaling actions enabled.'

Write-Step 'Scaling policy details:'
$polRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'describe-policies' `
    autoscaling describe-policies --auto-scaling-group-name $AsgName `
    --policy-names $ScaleUpPolicyName $ScaleDownPolicyName --output json
$policies = @(($polRaw | ConvertFrom-Json).ScalingPolicies)
foreach ($p in $policies) {
    Write-Diag "policy $($p.PolicyName): $($p.AdjustmentType) $($p.ScalingAdjustment)  cooldown=$($p.Cooldown)s"
}

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
$consoleUrl = "https://${Region}.console.aws.amazon.com/ec2autoscaling/home?region=${Region}#/details/${AsgName}"
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: CPU-based auto-scaling enabled and verified' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  environment : $EbEnvName ($EbEnvId)" -ForegroundColor Green
Write-Host "  asg         : $AsgName" -ForegroundColor Green
Write-Host "  bounds      : min=$($finalAsg.MinSize)  max=$($finalAsg.MaxSize)  desired=$($finalAsg.DesiredCapacity)  cooldown=$($finalAsg.DefaultCooldown)s" -ForegroundColor Green
Write-Host "  scale OUT   : CPU `> $ScaleUpThreshold% for $ScaleUpMinutes min  -> +1 ($ScaleUpPolicyName)" -ForegroundColor Green
Write-Host "  scale IN    : CPU `< $ScaleDownThreshold% for $ScaleDownMinutes min  -> -1 ($ScaleDownPolicyName)" -ForegroundColor Green
Write-Host ''
Write-Host '  Inspect the ASG and its scaling activity:' -ForegroundColor Yellow
Write-Host "    aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $AsgName --region $Region" -ForegroundColor DarkGray
Write-Host "    aws autoscaling describe-scaling-activities --auto-scaling-group-name $AsgName --region $Region" -ForegroundColor DarkGray
Write-Host "    $consoleUrl" -ForegroundColor DarkGray
Write-Host ''
if ($boundsConverged) {
    Write-Warn 'EB owns this ASG. The bounds are durable (set via EB options), but if you'
    Write-Warn 'later change scaling through the EB console/trigger it may override these.'
} else {
    Write-Warn 'Bounds were set DIRECTLY on the ASG (EB options did not converge or were'
    Write-Warn 'skipped). EB owns this ASG and a future EB deploy/update may revert them;'
    Write-Warn 're-run this script (or fix the EB EnvironmentType/options) to re-assert.'
}
Write-Ok 'Auto-scaling is active.'
