<#
================================================================================
 fix-waf-logging.ps1  -  Enable + VERIFY WAFv2 logging for the CloudFront WebACL
                         'anot-cloudfront-waf' (MEDIUM finding: logging disabled)
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHY THIS EXISTS:
   The production validation reported WAF logging as DISABLED (Section 3 -
   "WAF logging enabled" -> WARN). This script performs the SAME logging-enable
   steps as enable-cloudfront-waf.ps1 (run WITHOUT -NoLogging), but standalone,
   and then PROVES the fix by streaming a real request through CloudFront and
   confirming it shows up in the 'aws-waf-logs-anot-cloudfront' CloudWatch group.

 WHAT THIS SCRIPT DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks.
   PHASE 1     Resolve the existing CLOUDFRONT-scoped WebACL 'anot-cloudfront-waf'
               (it must already exist; if not, run enable-cloudfront-waf.ps1).
   PHASE 2     Ensure the CloudWatch log group 'aws-waf-logs-anot-cloudfront'
               exists in us-east-1 (create + set retention if missing).
   PHASE 3     Enable WAF logging (wafv2 put-logging-configuration) idempotently:
               skip if the WebACL already logs to this exact log group.
   PHASE 4     Send a request through CloudFront, then poll the log group until a
               WAF log event appears (proving end-to-end logging works).

 WHY us-east-1: a CLOUDFRONT-scoped WAFv2 WebACL and its log group live ONLY in
   us-east-1, and the log group name MUST start with 'aws-waf-logs-'. Every aws
   call here is pinned to us-east-1.

 SAFETY:
   * Idempotent: if logging is already pointed at the target log group, PHASE 3
     is skipped. The log group is reused if it already exists.
   * -DryRun does every read-only step and prints exactly what WOULD change
     WITHOUT creating the log group or calling put-logging-configuration.
   * Mutating steps prompt for confirmation unless -Force / -SkipConfirm.

 USAGE:
   powershell -File scripts/fix-waf-logging.ps1 -DryRun   # rehearse, no change
   powershell -File scripts/fix-waf-logging.ps1           # apply (prompts)
   powershell -File scripts/fix-waf-logging.ps1 -Force    # apply, no prompts
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun,
    [int]$LogWaitSeconds = 360,
    [int]$LogPollSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId    = '625242092266'
$DistributionId  = 'E6SKNV1EEXNPP'

# WAFv2 WebACL identity. CLOUDFRONT-scoped WebACLs live ONLY in us-east-1.
$WebAclName      = 'anot-cloudfront-waf'
$WebAclScope     = 'CLOUDFRONT'

# WAF logging: the destination log group name MUST start with 'aws-waf-logs-'.
$LogGroupName    = 'aws-waf-logs-anot-cloudfront'
$LogRetentionDays = 30

# Public test target (CloudFront default domain for this distribution).
$CloudFrontUrl   = 'https://d3t0m4s0ayca85.cloudfront.net/'

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'

# CloudFront + CLOUDFRONT-scoped WAFv2 are GLOBAL: their control plane only lives
# in us-east-1. Pin the region for every aws call here and disable the v2 pager.
$env:AWS_DEFAULT_REGION = 'us-east-1'
$env:AWS_PAGER = ''
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

# BOM-free UTF-8 write. The AWS CLI 'file://' parser rejects a UTF-8 BOM.
function Write-JsonFile {
    param([string]$Path, [object]$Object)
    $json = $Object | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

# Throwing AWS CLI wrapper for MUTATING calls. Captures stdout/stderr without
# corrupting JSON, retries with backoff, and throws a detailed diagnostic on
# failure. -SkipInDryRun marks a mutating call (skipped + printed in -DryRun).
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
            "  region   : $($env:AWS_DEFAULT_REGION)",
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

# Non-throwing AWS CLI wrapper for READ/VERIFY calls. Returns a record:
#   @{ Ok; Code; Stdout; Stderr; Json }  (Json is parsed when output is JSON).
# A non-zero exit (e.g. WAFNonexistentItem) is reported, not thrown, so a check
# can branch on it instead of aborting the run.
function Invoke-AwsRead {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [string]$What,
        [int]$Retries = 3,
        [int]$DelaySeconds = 4,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs
    )
    if (-not $CliArgs -or $CliArgs.Count -eq 0) { throw 'Invoke-AwsRead called with no AWS CLI arguments.' }

    $result = [pscustomobject]@{ Ok = $false; Code = $null; Stdout = ''; Stderr = ''; Json = $null }
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
            $code = 9001
            $captured = $_.Exception.Message
        }
        finally {
            $ErrorActionPreference = $prevEap
        }

        $outParts = @(); $errParts = @()
        foreach ($item in @($captured)) {
            if ($null -eq $item) { continue }
            if ($item -is [System.Management.Automation.ErrorRecord]) { $errParts += $item.ToString() }
            else { $outParts += [string]$item }
        }
        $stdout = ($outParts -join "`n")
        $stderr = (($errParts -join "`n")).Trim()

        if ($code -eq 0) {
            $result.Ok = $true; $result.Code = 0; $result.Stdout = $stdout
            if ($stdout -and ($stdout.TrimStart().StartsWith('{') -or $stdout.TrimStart().StartsWith('['))) {
                try { $result.Json = $stdout | ConvertFrom-Json } catch { $result.Json = $null }
            }
            return $result
        }

        if ($attempt -lt $Retries) { Start-Sleep -Seconds $DelaySeconds; continue }

        $result.Ok = $false; $result.Code = $code; $result.Stdout = $stdout; $result.Stderr = $stderr
        return $result
    }
}
#endregion

# ------------------------------------------------------------------------------
# Failure trap: name the phase, show the underlying error, exit non-zero.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  FIX WAF LOGGING FAILED' -ForegroundColor Red
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
Write-Phase 'PRE-FLIGHT: tooling + identity checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No log group or logging changes will be made.'
} else {
    Write-Step 'LIVE MODE: this run will ensure WAF logging is enabled and prove it end-to-end.'
}

Write-Step 'Checking AWS CLI is installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Step "AWS CLI: $awsVersion"

Write-Step 'Verifying AWS identity...'
$identity = Invoke-Aws sts get-caller-identity --output json | ConvertFrom-Json
Write-Step "Authenticated as: $($identity.Arn)"
if ($identity.Account -ne $AwsAccountId) {
    throw "Wrong AWS account: $($identity.Account) (expected $AwsAccountId)."
}

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Resolve the existing CLOUDFRONT WebACL
# ==============================================================================
Write-Phase 'PHASE 1: Resolve the CLOUDFRONT WebACL'

Write-Step "Looking for a CLOUDFRONT WebACL named '$WebAclName'..."
$listRes = Invoke-AwsRead -What 'wafv2 list-web-acls' -Retries 3 -DelaySeconds 5 `
    wafv2 list-web-acls --scope $WebAclScope --output json
if (-not $listRes.Ok) { throw "Could not list WebACLs: $($listRes.Stderr)" }

$summary = $null
if ($listRes.Json -and ($listRes.Json.PSObject.Properties.Name -contains 'WebACLs')) {
    $match = @($listRes.Json.WebACLs | Where-Object { $_.Name -eq $WebAclName })
    if ($match.Count -gt 0) { $summary = $match[0] }
}
if ($null -eq $summary) {
    throw "CLOUDFRONT WebACL '$WebAclName' not found. Create it first with: scripts/enable-cloudfront-waf.ps1"
}

$WebAclArn = $summary.ARN
$WebAclId  = $summary.Id
Write-Ok "Found WebACL '$WebAclName'."
Write-Diag "id  : $WebAclId"
Write-Diag "arn : $WebAclArn"

# ==============================================================================
# PHASE 2 - Ensure the CloudWatch log group exists (us-east-1)
# ==============================================================================
Write-Phase 'PHASE 2: Ensure the WAF log group exists'

Write-Step "Checking CloudWatch log group '$LogGroupName'..."
$lgRes = Invoke-AwsRead -What 'logs describe-log-groups' -Retries 3 -DelaySeconds 5 `
    logs describe-log-groups --log-group-name-prefix $LogGroupName --output json
$haveLg = $false
if ($lgRes.Ok -and $lgRes.Json) {
    $haveLg = @($lgRes.Json.logGroups | Where-Object { $_.logGroupName -eq $LogGroupName }).Count -gt 0
}

if ($haveLg) {
    Write-Ok "Log group '$LogGroupName' already exists."
} else {
    Confirm-Step "Create CloudWatch log group '$LogGroupName' for WAF logs now?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "create-log-group $LogGroupName" `
        logs create-log-group --log-group-name $LogGroupName | Out-Null
    Invoke-Aws -SkipInDryRun -Retries 2 -DelaySeconds 5 -What "put-retention-policy $LogGroupName" `
        logs put-retention-policy --log-group-name $LogGroupName --retention-in-days $LogRetentionDays | Out-Null
    if (-not $DryRun) { Write-Ok "Created log group '$LogGroupName' (retention ${LogRetentionDays}d)." }
    else { Write-Ok "[DRY-RUN] would create log group '$LogGroupName' (retention ${LogRetentionDays}d)." }
}

# ==============================================================================
# PHASE 3 - Enable WAF logging (idempotent)
# ==============================================================================
Write-Phase 'PHASE 3: Enable WAF logging to CloudWatch Logs'

# WAF logging-configuration wants the log group ARN WITHOUT a trailing ':*'.
$LogGroupArn = "arn:aws:logs:us-east-1:${AwsAccountId}:log-group:$LogGroupName"

Write-Step 'Checking the current logging configuration...'
$curRes = Invoke-AwsRead -What 'wafv2 get-logging-configuration' -Retries 2 -DelaySeconds 5 `
    wafv2 get-logging-configuration --resource-arn $WebAclArn --output json
$alreadyLogging = $false
if ($curRes.Ok -and $curRes.Json) {
    $dests = @($curRes.Json.LoggingConfiguration.LogDestinationConfigs)
    Write-Diag "current log destinations: $($dests -join ', ')"
    if ($dests -contains $LogGroupArn) { $alreadyLogging = $true }
} elseif ($curRes.Stderr -match 'WAFNonexistentItem|not.*found') {
    Write-Diag 'no logging configuration currently set.'
} else {
    Write-Warn "Could not read current logging configuration: $($curRes.Stderr)"
}

if ($alreadyLogging) {
    Write-Ok "WAF logging is ALREADY enabled to '$LogGroupName'. Nothing to change."
} else {
    $loggingConfig = [ordered]@{
        ResourceArn           = $WebAclArn
        LogDestinationConfigs = @($LogGroupArn)
    }
    $loggingFile = Join-Path $ArtifactDir "waf-logging-$DistributionId-$Stamp.json"
    Write-JsonFile -Path $loggingFile -Object $loggingConfig
    Write-Step "Wrote logging-configuration document to $loggingFile"

    Confirm-Step "Enable WAF logging for '$WebAclName' -> $LogGroupArn now?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-logging-configuration $WebAclName" `
        wafv2 put-logging-configuration `
        --logging-configuration "file://$loggingFile" `
        --output json | Out-Null
    if (-not $DryRun) { Write-Ok "WAF logging enabled -> $LogGroupName" }
    else { Write-Ok "[DRY-RUN] would enable WAF logging -> $LogGroupName" }
}

# ==============================================================================
# PHASE 4 - Stream a request + verify WAF logs appear
# ==============================================================================
Write-Phase 'PHASE 4: Send a request and confirm it is logged'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: logging-enable steps validated; no changes were made.'
    Write-Warn 'No request was sent and no log verification was performed.'
    Write-Host ''
    return
}

# Re-confirm logging is reported as configured before we test for events.
Write-Step 'Verifying logging configuration is reported by WAF...'
$verRes = Invoke-AwsRead -What 'wafv2 get-logging-configuration (verify)' -Retries 4 -DelaySeconds 5 `
    wafv2 get-logging-configuration --resource-arn $WebAclArn --output json
if ($verRes.Ok -and $verRes.Json -and (@($verRes.Json.LoggingConfiguration.LogDestinationConfigs) -contains $LogGroupArn)) {
    Write-Ok "Logging configuration confirmed -> $LogGroupName"
} else {
    Write-Warn 'Logging configuration not yet visible (it may still be propagating).'
}

# Capture a start time slightly in the past, then send a request through CloudFront.
$startMs = [DateTimeOffset]::UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds()
Write-Step "Sending a test request to $CloudFrontUrl ..."
try {
    $resp = Invoke-WebRequest -Uri $CloudFrontUrl -UseBasicParsing -TimeoutSec 30
    Write-Diag "HTTP $($resp.StatusCode) (request will be evaluated + logged by WAF)"
} catch {
    Write-Warn "Test request raised: $($_.Exception.Message) (an HTTP error still gets logged by WAF)"
}

Write-Step "Polling '$LogGroupName' for WAF log events (up to ${LogWaitSeconds}s)..."
Write-Diag 'WAF -> CloudWatch delivery is near-real-time but can lag a few minutes.'
$deadline = (Get-Date).AddSeconds($LogWaitSeconds)
$logged = $false
$eventCount = 0
while ((Get-Date) -lt $deadline) {
    $evRes = Invoke-AwsRead -What 'logs filter-log-events' -Retries 2 -DelaySeconds 3 `
        logs filter-log-events --log-group-name $LogGroupName --start-time $startMs --limit 5 --output json
    if ($evRes.Ok -and $evRes.Json) {
        $events = @($evRes.Json.events)
        $eventCount = $events.Count
        if ($eventCount -gt 0) { $logged = $true; break }
    } elseif ($evRes.Stderr -match 'ResourceNotFoundException') {
        Write-Diag 'log group not visible yet; waiting...'
    }
    Start-Sleep -Seconds $LogPollSeconds
    Write-Diag "still waiting for the first WAF log event... ($([int]($deadline - (Get-Date)).TotalSeconds)s left)"
}

if ($logged) {
    Write-Ok "WAF logs are streaming: found $eventCount event(s) in '$LogGroupName'."
} else {
    Write-Warn "No WAF log events seen within ${LogWaitSeconds}s. Logging IS configured;"
    Write-Warn 'delivery can take several minutes on first enablement. Re-check later with:'
    Write-Diag "aws logs filter-log-events --log-group-name $LogGroupName --start-time $startMs --region us-east-1"
}

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: WAF logging is enabled for the CloudFront WebACL' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  web acl    : $WebAclName ($WebAclId)" -ForegroundColor Green
Write-Host "  log group  : $LogGroupName (us-east-1)" -ForegroundColor Green
Write-Host "  log events : $(if ($logged) { "confirmed ($eventCount seen)" } else { 'configured (not yet observed)' })" -ForegroundColor Green
Write-Host ''
Write-Host '  Re-run the validation to confirm the finding is resolved:' -ForegroundColor Yellow
Write-Host '    powershell -File scripts/validate-production.ps1 -Live' -ForegroundColor DarkGray
Write-Host ''
if ($logged) { Write-Ok 'WAF logging fix complete and verified.' }
else { Write-Warn 'WAF logging fix applied; verification pending log delivery.' }
exit 0
