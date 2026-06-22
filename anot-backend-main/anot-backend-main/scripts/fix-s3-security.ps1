<#
================================================================================
 fix-s3-security.ps1  -  Enforce default encryption-at-rest + full public-access
                         block on the anot S3 buckets (MEDIUM finding)
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHY THIS EXISTS:
   The production validation flagged S3 bucket security (Section 3 - "S3
   encryption at rest" and "S3 public access block"). This script makes both
   buckets correct and PROVES it:
     * default server-side encryption = AES256 (SSE-S3) on each bucket
     * S3 Block Public Access = all FOUR settings ON for each bucket

 BUCKETS:
   anot-audio-625242092266      (audio uploads)
   anot-frontend-625242092266   (SPA static assets, served via CloudFront/OAC)

 WHAT THIS DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks; confirm each bucket is reachable.
   PHASE 1     For each bucket: ensure default SSE (AES256). Skip if already set.
   PHASE 2     For each bucket: ensure Block Public Access (all 4). Skip if set.
   PHASE 3     Verify both via get-bucket-encryption + get-public-access-block.

 IDEMPOTENT: each setting is read first; a put is issued ONLY when the bucket is
   missing the setting (or it is partial). Re-running is a safe no-op.

 SAFETY:
   * -DryRun does every read-only step and prints exactly what WOULD change
     WITHOUT calling put-bucket-encryption or put-public-access-block.
   * Mutating steps prompt for confirmation unless -Force / -SkipConfirm.

 USAGE:
   powershell -File scripts/fix-s3-security.ps1 -DryRun   # rehearse, no change
   powershell -File scripts/fix-s3-security.ps1           # apply (prompts)
   powershell -File scripts/fix-s3-security.ps1 -Force    # apply, no prompts
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId = '625242092266'
$Region       = 'ap-southeast-1'

$Buckets = @(
    "anot-audio-$AwsAccountId",
    "anot-frontend-$AwsAccountId"
)

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'

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

# Throwing AWS CLI wrapper for MUTATING calls. -SkipInDryRun marks a mutating
# call (skipped + printed in -DryRun).
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

# Non-throwing AWS CLI wrapper for READ checks. A non-zero exit (e.g.
# ServerSideEncryptionConfigurationNotFoundError / NoSuchPublicAccessBlock) is
# reported, not thrown, so the script can branch on the "not configured" case.
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

        # Do NOT retry the well-known "not configured" sentinels (they are stable).
        if ($stderr -match 'ServerSideEncryptionConfigurationNotFoundError|NoSuchPublicAccessBlockConfiguration') {
            $result.Ok = $false; $result.Code = $code; $result.Stdout = $stdout; $result.Stderr = $stderr
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
    Write-Host '  FIX S3 SECURITY FAILED' -ForegroundColor Red
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
Write-Phase 'PRE-FLIGHT: tooling + identity + bucket reachability'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No bucket settings will be changed.'
} else {
    Write-Step 'LIVE MODE: this run will enforce encryption + public-access-block on the buckets.'
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

foreach ($bkt in $Buckets) {
    Write-Step "Confirming bucket '$bkt' is reachable..."
    $hb = Invoke-AwsRead -What "head-bucket $bkt" -Retries 3 -DelaySeconds 4 s3api head-bucket --bucket $bkt
    if (-not $hb.Ok) { throw "Bucket '$bkt' is not reachable: $($hb.Stderr)" }
    Write-Diag "bucket '$bkt' OK."
}
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Ensure default encryption-at-rest (AES256) on each bucket
# ==============================================================================
Write-Phase 'PHASE 1: Default encryption at rest (AES256)'

# SSE-S3 (AES256) default-encryption document, reused for both buckets.
$encConfig = [ordered]@{
    Rules = @(
        [ordered]@{
            ApplyServerSideEncryptionByDefault = [ordered]@{ SSEAlgorithm = 'AES256' }
            BucketKeyEnabled                   = $true
        }
    )
}
$encFile = Join-Path $ArtifactDir "s3-encryption-$Stamp.json"
Write-JsonFile -Path $encFile -Object $encConfig

foreach ($bkt in $Buckets) {
    Write-Step "Checking default encryption on '$bkt'..."
    $r = Invoke-AwsRead -What "get-bucket-encryption $bkt" s3api get-bucket-encryption --bucket $bkt --output json
    $needsEnc = $false
    if ($r.Ok -and $r.Json) {
        $alg = @($r.Json.ServerSideEncryptionConfiguration.Rules)[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm
        Write-Diag "current default encryption: $alg"
        Write-Ok "'$bkt' already has default encryption ($alg). Skipping."
    } elseif ($r.Stderr -match 'ServerSideEncryptionConfigurationNotFoundError') {
        Write-Diag "no default encryption configured."
        $needsEnc = $true
    } else {
        throw "Could not read encryption for '$bkt': $($r.Stderr)"
    }

    if ($needsEnc) {
        Confirm-Step "Enable default AES256 encryption on '$bkt' now?"
        Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-bucket-encryption $bkt" `
            s3api put-bucket-encryption --bucket $bkt `
            --server-side-encryption-configuration "file://$encFile" | Out-Null
        if (-not $DryRun) { Write-Ok "Enabled default AES256 encryption on '$bkt'." }
        else { Write-Ok "[DRY-RUN] would enable default AES256 encryption on '$bkt'." }
    }
}

# ==============================================================================
# PHASE 2 - Ensure Block Public Access (all 4) on each bucket
# ==============================================================================
Write-Phase 'PHASE 2: Block Public Access (all four settings)'

$pabSetting = 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'

foreach ($bkt in $Buckets) {
    Write-Step "Checking public-access-block on '$bkt'..."
    $r = Invoke-AwsRead -What "get-public-access-block $bkt" s3api get-public-access-block --bucket $bkt --output json
    $needsPab = $false
    if ($r.Ok -and $r.Json) {
        $c = $r.Json.PublicAccessBlockConfiguration
        $all = ($c.BlockPublicAcls -and $c.IgnorePublicAcls -and $c.BlockPublicPolicy -and $c.RestrictPublicBuckets)
        Write-Diag "BlockPublicAcls=$($c.BlockPublicAcls) IgnorePublicAcls=$($c.IgnorePublicAcls) BlockPublicPolicy=$($c.BlockPublicPolicy) RestrictPublicBuckets=$($c.RestrictPublicBuckets)"
        if ($all) { Write-Ok "'$bkt' already blocks all public access. Skipping." }
        else { Write-Diag 'public-access-block is partial.'; $needsPab = $true }
    } elseif ($r.Stderr -match 'NoSuchPublicAccessBlockConfiguration') {
        Write-Diag 'no public-access-block configured.'
        $needsPab = $true
    } else {
        throw "Could not read public-access-block for '$bkt': $($r.Stderr)"
    }

    if ($needsPab) {
        Confirm-Step "Apply full public-access-block (all 4) on '$bkt' now?"
        Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-public-access-block $bkt" `
            s3api put-public-access-block --bucket $bkt `
            --public-access-block-configuration $pabSetting | Out-Null
        if (-not $DryRun) { Write-Ok "Applied full public-access-block on '$bkt'." }
        else { Write-Ok "[DRY-RUN] would apply full public-access-block on '$bkt'." }
    }
}

# ==============================================================================
# PHASE 3 - Verify both settings on both buckets
# ==============================================================================
Write-Phase 'PHASE 3: Verify encryption + public-access-block'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: read-only checks + planned changes validated. No changes were made.'
    Write-Host ''
    return
}

$allGood = $true
foreach ($bkt in $Buckets) {
    Write-Step "Verifying '$bkt'..."

    $er = Invoke-AwsRead -What "verify get-bucket-encryption $bkt" s3api get-bucket-encryption --bucket $bkt --output json
    if ($er.Ok -and $er.Json) {
        $alg = @($er.Json.ServerSideEncryptionConfiguration.Rules)[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm
        Write-Ok "encryption: $alg"
    } else {
        Write-Warn "encryption NOT verified on '$bkt': $($er.Stderr)"
        $allGood = $false
    }

    $pr = Invoke-AwsRead -What "verify get-public-access-block $bkt" s3api get-public-access-block --bucket $bkt --output json
    if ($pr.Ok -and $pr.Json) {
        $c = $pr.Json.PublicAccessBlockConfiguration
        $all = ($c.BlockPublicAcls -and $c.IgnorePublicAcls -and $c.BlockPublicPolicy -and $c.RestrictPublicBuckets)
        if ($all) { Write-Ok 'public access: all four block settings ON' }
        else {
            Write-Warn "public-access-block partial on '$bkt' (BlockPublicAcls=$($c.BlockPublicAcls) IgnorePublicAcls=$($c.IgnorePublicAcls) BlockPublicPolicy=$($c.BlockPublicPolicy) RestrictPublicBuckets=$($c.RestrictPublicBuckets))."
            $allGood = $false
        }
    } else {
        Write-Warn "public-access-block NOT verified on '$bkt': $($pr.Stderr)"
        $allGood = $false
    }
}

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
Write-Host ''
if ($allGood) {
    Write-Host ('=' * 78) -ForegroundColor Green
    Write-Host '  SUCCESS: both buckets are encrypted at rest and block all public access' -ForegroundColor Green
    Write-Host ('=' * 78) -ForegroundColor Green
} else {
    Write-Host ('=' * 78) -ForegroundColor Yellow
    Write-Host '  PARTIAL: changes applied but one or more verifications did not pass' -ForegroundColor Yellow
    Write-Host ('=' * 78) -ForegroundColor Yellow
}
foreach ($bkt in $Buckets) { Write-Host "  bucket : $bkt" -ForegroundColor Green }
Write-Host '  encryption  : default SSE AES256 (SSE-S3)' -ForegroundColor Green
Write-Host '  public block: BlockPublicAcls + IgnorePublicAcls + BlockPublicPolicy + RestrictPublicBuckets' -ForegroundColor Green
Write-Host ''
Write-Host '  Re-run the validation to confirm the finding is resolved:' -ForegroundColor Yellow
Write-Host '    powershell -File scripts/validate-production.ps1 -Live' -ForegroundColor DarkGray
Write-Host ''
if ($allGood) { Write-Ok 'S3 security fix complete and verified.'; exit 0 }
else { Write-Warn 'S3 security fix applied but verification was incomplete; re-check above.'; exit 1 }
