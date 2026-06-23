<#
================================================================================
 tag-rds-production.ps1  -  Apply the standard production cost/governance tags to
                            the RDS instance 'anot-postgres' (idempotent).
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHY THIS EXISTS:
   The platform audit flagged RDS resource tagging as a MANUAL step. Consistent
   tags drive cost allocation (CostCenter), ownership/escalation (Owner), and
   environment-scoped automation/guardrails (Environment, Application). This
   script applies the standard tag set and is fully idempotent: it only writes
   tags that are MISSING or have a DIFFERENT value, and is a no-op once correct.

 THE STANDARD TAG SET:
   Environment = production
   Application = anot-health
   CostCenter  = medical
   Owner       = anot-ops
   CreatedDate = 2026-06-22     (override with -CreatedDate yyyy-MM-dd)

 WHAT THIS SCRIPT DOES:
   PHASE 1  Resolve the RDS instance ARN (rds describe-db-instances).
   PHASE 2  Read current tags (rds list-tags-for-resource) and diff against the
            standard set to compute exactly which tags need to be added/updated.
   PHASE 3  Apply only the missing/changed tags (rds add-tags-to-resource).
   PHASE 4  Re-read tags and VERIFY every standard tag is present with the
            expected value.

 SAFETY:
   * Idempotent: tags already correct are left untouched; a fully-tagged DB makes
     this a no-op (PHASE 3 applies nothing).
   * Only ADDS/updates the standard keys; never removes other existing tags.
   * -DryRun reads + diffs and prints exactly what WOULD be applied, no writes.
   * Mutating step prompts for confirmation unless -Force / -SkipConfirm.

 USAGE:
   powershell -File scripts/tag-rds-production.ps1 -DryRun
   powershell -File scripts/tag-rds-production.ps1
   powershell -File scripts/tag-rds-production.ps1 -Force
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Live,
    [switch]$Force,
    [switch]$SkipConfirm,
    [string]$RdsInstanceId = 'anot-postgres',
    [string]$CreatedDate   = '2026-06-22'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId = '625242092266'
$Region       = 'ap-southeast-1'

# The standard production tag set (ordered for stable, readable output).
$DesiredTags = [ordered]@{
    Environment = 'production'
    Application = 'anot-health'
    CostCenter  = 'medical'
    Owner       = 'anot-ops'
    CreatedDate = $CreatedDate
}

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'
$ResultJson  = Join-Path $ArtifactDir "rds-tagging-$Stamp.json"

# Default to LIVE if neither switch was given.
if (-not $DryRun -and -not $Live) { $Live = $true }
if ($DryRun) { $Live = $false }

$env:AWS_DEFAULT_REGION = $Region
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
    if ($DryRun)                 { Write-Step "[DRY-RUN] would prompt: $Message"; return $true }
    if ($Force -or $SkipConfirm) { Write-Step "$Message (auto-confirmed)"; return $true }
    $answer = Read-Host "  ?? $Message  [y/N]"
    return ($answer -match '^(y|yes)$')
}

# Throwing AWS CLI wrapper for MUTATING calls. -SkipInDryRun prints + skips.
function Invoke-Aws {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [int]$Retries = 3,
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
        try { $captured = & aws @CliArgs 2>&1; $code = $LASTEXITCODE }
        catch { $code = 9001; $captured = $_.Exception.Message }
        finally { $ErrorActionPreference = $prevEap }

        $outParts = @(); $errParts = @()
        foreach ($item in @($captured)) {
            if ($null -eq $item) { continue }
            if ($item -is [System.Management.Automation.ErrorRecord]) { $errParts += $item.ToString() }
            else { $outParts += [string]$item }
        }
        $stdout = ($outParts -join "`n"); $stderr = (($errParts -join "`n")).Trim()
        if ($code -eq 0) { return $stdout }
        if ($attempt -lt $Retries) { Start-Sleep -Seconds $DelaySeconds; continue }
        $lines = @("AWS CLI call FAILED: $label", "  command : $cmdText", "  exit    : $code")
        if ($stderr) { $lines += "  error   : $stderr" }
        throw ($lines -join "`n")
    }
}

# Non-throwing read wrapper. Returns @{ Ok; Code; Stdout; Stderr; Json }.
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
        try { $captured = & aws @CliArgs 2>&1; $code = $LASTEXITCODE }
        catch { $code = 9001; $captured = $_.Exception.Message }
        finally { $ErrorActionPreference = $prevEap }

        $outParts = @(); $errParts = @()
        foreach ($item in @($captured)) {
            if ($null -eq $item) { continue }
            if ($item -is [System.Management.Automation.ErrorRecord]) { $errParts += $item.ToString() }
            else { $outParts += [string]$item }
        }
        $stdout = ($outParts -join "`n"); $stderr = (($errParts -join "`n")).Trim()
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

trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  TAG-RDS-PRODUCTION FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    Write-Host ''
    exit 1
}
# =============================================================================
# PRE-FLIGHT
# =============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity'

if ($DryRun) { Write-Warn 'DRY-RUN MODE: reads + diffs tags and prints the plan; no tags are written.' }
else         { Write-Step 'LIVE MODE: missing/changed standard tags will be applied to the RDS instance.' }

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null

Write-Step 'Checking AWS CLI is installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Diag "AWS CLI: $awsVersion"

Write-Step 'Verifying AWS identity...'
$idr = Invoke-AwsRead -What 'sts get-caller-identity' sts get-caller-identity --output json
if (-not $idr.Ok -or -not $idr.Json) { throw "Could not verify AWS identity: $($idr.Stderr)" }
Write-Diag "Authenticated as: $($idr.Json.Arn)"
if ($idr.Json.Account -ne $AwsAccountId) { Write-Warn "authenticated account $($idr.Json.Account) != expected $AwsAccountId" }

Write-Host ''
Write-Host '  Standard tag set to enforce:' -ForegroundColor Gray
foreach ($k in $DesiredTags.Keys) { Write-Diag "$k = $($DesiredTags[$k])" }

# =============================================================================
# PHASE 1 - Resolve the RDS instance ARN
# =============================================================================
Write-Phase 'PHASE 1: resolve the RDS instance ARN'

$dbRes = Invoke-AwsRead -What 'rds describe-db-instances' rds describe-db-instances --db-instance-identifier $RdsInstanceId --output json
if (-not $dbRes.Ok -or -not $dbRes.Json -or @($dbRes.Json.DBInstances).Count -eq 0) {
    throw "RDS instance '$RdsInstanceId' not found (or describe denied): $($dbRes.Stderr)"
}
$db = @($dbRes.Json.DBInstances)[0]
$rdsArn = $db.DBInstanceArn
Write-Ok "Found RDS instance '$RdsInstanceId'."
Write-Diag "arn    : $rdsArn"
Write-Diag "status : $($db.DBInstanceStatus); engine $($db.Engine) $($db.EngineVersion)"

# =============================================================================
# PHASE 2 - Read current tags + compute the diff
# =============================================================================
Write-Phase 'PHASE 2: read current tags + compute the diff'

$tagRes = Invoke-AwsRead -What 'rds list-tags-for-resource' rds list-tags-for-resource --resource-name $rdsArn --output json
if (-not $tagRes.Ok) { throw "Could not read RDS tags: $($tagRes.Stderr)" }
$currentTags = @{}
foreach ($t in @($tagRes.Json.TagList)) { $currentTags[$t.Key] = $t.Value }
Write-Diag "current tags: $(if ($currentTags.Keys.Count) { (@($currentTags.Keys | ForEach-Object { "$_=$($currentTags[$_])" }) -join ', ') } else { '(none)' })"

# Decide which standard tags must be written (absent) or corrected (wrong value).
$toApply = [ordered]@{}
$alreadyOk = @()
foreach ($k in $DesiredTags.Keys) {
    $want = $DesiredTags[$k]
    if ($currentTags.ContainsKey($k) -and ("$($currentTags[$k])" -ceq "$want")) {
        $alreadyOk += $k
    } else {
        $toApply[$k] = $want
    }
}

Write-Host ''
foreach ($k in $DesiredTags.Keys) {
    if ($alreadyOk -contains $k) {
        Write-Host "    [OK]      $k = $($DesiredTags[$k])" -ForegroundColor Green
    } elseif ($currentTags.ContainsKey($k)) {
        Write-Host "    [UPDATE]  $k : '$($currentTags[$k])' -> '$($DesiredTags[$k])'" -ForegroundColor Yellow
    } else {
        Write-Host "    [ADD]     $k = $($DesiredTags[$k])" -ForegroundColor Yellow
    }
}

if ($toApply.Keys.Count -eq 0) {
    Write-Host ''
    Write-Ok 'All standard tags are already present with the expected values. Nothing to do.'
    $summary = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        mode        = $(if ($DryRun) { 'dry-run' } else { 'live' })
        resource    = $rdsArn
        desiredTags = $DesiredTags
        applied     = @()
        alreadyOk   = $alreadyOk
        verified    = $true
    }
    [System.IO.File]::WriteAllText($ResultJson, ($summary | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
    Write-Step "Results -> $ResultJson"
    exit 0
}

# =============================================================================
# PHASE 3 - Apply the missing/changed tags
# =============================================================================
Write-Phase 'PHASE 3: apply missing/changed tags'

# Build the --tags argument: Key=..,Value=.. pairs, only for the diff set.
$tagArgs = @()
foreach ($k in $toApply.Keys) { $tagArgs += "Key=$k,Value=$($toApply[$k])" }

if (Confirm-Step "Apply $($toApply.Keys.Count) tag(s) to RDS '$RdsInstanceId'?") {
    Invoke-Aws -SkipInDryRun -What 'rds add-tags-to-resource' `
        rds add-tags-to-resource --resource-name $rdsArn --tags @tagArgs | Out-Null
    if (-not $DryRun) { Write-Ok "Applied $($toApply.Keys.Count) tag(s)." }
    else { Write-Ok "[DRY-RUN] would apply: $($tagArgs -join ' ')" }
} else {
    Write-Warn 'Declined. No tags applied.'
    exit 0
}

if ($DryRun) {
    $summary = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        mode        = 'dry-run'
        resource    = $rdsArn
        desiredTags = $DesiredTags
        wouldApply  = @($toApply.Keys | ForEach-Object { [ordered]@{ key = $_; value = $toApply[$_] } })
        alreadyOk   = $alreadyOk
    }
    [System.IO.File]::WriteAllText($ResultJson, ($summary | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
    Write-Step "Results -> $ResultJson"
    Write-Host ''
    Write-Host '  Re-run without -DryRun to apply.' -ForegroundColor Gray
    exit 0
}

# =============================================================================
# PHASE 4 - Verify tags were applied
# =============================================================================
Write-Phase 'PHASE 4: verify tags'

$verRes = Invoke-AwsRead -What 'rds list-tags-for-resource (verify)' rds list-tags-for-resource --resource-name $rdsArn --output json
$finalTags = @{}
if ($verRes.Ok -and $verRes.Json) { foreach ($t in @($verRes.Json.TagList)) { $finalTags[$t.Key] = $t.Value } }

$missing = @()
foreach ($k in $DesiredTags.Keys) {
    if (-not ($finalTags.ContainsKey($k) -and ("$($finalTags[$k])" -ceq "$($DesiredTags[$k])"))) { $missing += $k }
}

if ($missing.Count -eq 0) {
    foreach ($k in $DesiredTags.Keys) { Write-Ok "$k = $($finalTags[$k])" }
} else {
    Write-Warn "Verification: $($missing.Count) tag(s) not confirmed: $($missing -join ', ')."
}

$summary = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    mode        = 'live'
    resource    = $rdsArn
    desiredTags = $DesiredTags
    applied     = @($toApply.Keys | ForEach-Object { [ordered]@{ key = $_; value = $toApply[$_] } })
    alreadyOk   = $alreadyOk
    finalTags   = $finalTags
    verified    = ($missing.Count -eq 0)
    missing     = $missing
}
[System.IO.File]::WriteAllText($ResultJson, ($summary | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
Write-Step "Results -> $ResultJson"

Write-Host ''
Write-Host ('=' * 78) -ForegroundColor $(if ($missing.Count -eq 0) { 'Green' } else { 'Yellow' })
if ($missing.Count -eq 0) { Write-Host "  DONE: RDS '$RdsInstanceId' carries all $($DesiredTags.Keys.Count) standard production tags." -ForegroundColor Green }
else { Write-Host "  PARTIAL: $($missing.Count) tag(s) could not be confirmed on RDS '$RdsInstanceId'." -ForegroundColor Yellow }
Write-Host ('=' * 78) -ForegroundColor $(if ($missing.Count -eq 0) { 'Green' } else { 'Yellow' })
Write-Host '  Next: powershell -File scripts/verify-production-100-percent.ps1 -Live' -ForegroundColor Gray
Write-Host ''

if ($missing.Count -eq 0) { exit 0 } else { exit 1 }

