<#
================================================================================
 enable-cloudfront-oac.ps1  -  Lock the CloudFront S3 origin behind Origin
                               Access Control (OAC) and make the bucket private
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHAT THIS DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks; confirm the distribution + bucket.
   PHASE 1     Create (or reuse) a CloudFront Origin Access Control (scope=S3,
               SigningProtocol=sigv4, SigningBehavior=always).
   PHASE 2     Attach the OAC to the 's3-frontend' origin (also normalizes the
               origin to the S3 REST endpoint + S3OriginConfig), then update the
               distribution atomically (--if-match) and wait for it to deploy.
   PHASE 3     Rewrite the S3 bucket policy so ONLY this CloudFront distribution
               (via the OAC service principal + AWS:SourceArn) may GetObject. Any
               existing PUBLIC (Principal '*') Allow statements are removed.
   PHASE 4     Enable S3 Block Public Access (all four settings) on the bucket.
   PHASE 5     Verify CloudFront still serves HTTP 200, and (soft check) that the
               bucket is no longer directly readable from the public internet.

 WHY THE ORDER MATTERS (no-downtime migration):
   While the distribution is still deploying, some edges may issue UNSIGNED reads
   and others SIGNED (OAC) reads. As long as the bucket is still public during
   that window, both succeed -> no 403s. We therefore WAIT for Status=Deployed in
   PHASE 2 BEFORE tightening the bucket policy in PHASE 3. Only after every edge
   signs with the OAC do we remove public access and turn on Block Public Access.

 SAFETY:
   * Idempotent: reuses an existing OAC by name; skips the distribution update if
     the origin already uses this OAC; skips the bucket-policy / BPA writes if
     they already match the desired state.
   * Atomic CloudFront update (--if-match <ETag>); the ORIGINAL distribution
     config, bucket policy, and public-access-block are saved to disk first.
   * -DryRun does every read-only step and writes the proposed documents to disk
     WITHOUT creating the OAC, updating the distribution, or touching the bucket.
   * Mutating steps prompt for confirmation unless -Force / -SkipConfirm.

 USAGE:
   powershell -File scripts/enable-cloudfront-oac.ps1 -DryRun   # rehearse
   powershell -File scripts/enable-cloudfront-oac.ps1           # apply (prompts)
   powershell -File scripts/enable-cloudfront-oac.ps1 -Force    # apply, no prompts
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
$AwsAccountId    = '625242092266'
$Region          = 'ap-southeast-1'           # the S3 bucket's region
$DistributionId  = 'E6SKNV1EEXNPP'
$OriginId        = 's3-frontend'
$FrontendBucket  = "anot-frontend-$AwsAccountId"
$RestEndpoint    = "$FrontendBucket.s3.$Region.amazonaws.com"

# CloudFront ARNs have NO region component. Used in the bucket-policy condition.
$DistributionArn = "arn:aws:cloudfront::${AwsAccountId}:distribution/${DistributionId}"

# OAC identity. CloudFront OACs are global (managed via the us-east-1 control plane).
$OacName         = 'anot-frontend-oac'
$OacDescription  = 'OAC for anot frontend S3 origin (CloudFront-only access).'

# Bucket-policy statement id for the CloudFront-only read grant (idempotent key).
$BucketPolicySid = 'AllowCloudFrontServicePrincipalReadOnly'

# Public test target (CloudFront default domain for this distribution).
$CloudFrontUrl   = 'https://d3t0m4s0ayca85.cloudfront.net/'
$DirectS3Url     = "https://$RestEndpoint/index.html"   # should become FORBIDDEN

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'

# CloudFront + CLOUDFRONT-scoped resources are GLOBAL: their control plane only
# lives in us-east-1. Pin the region for every aws call here and disable the pager.
# (s3api calls below pass --region explicitly to hit the bucket's home region.)
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

# BOM-free UTF-8 write. The AWS CLI 'file://' parser rejects a UTF-8 BOM, and
# Out-File -Encoding utf8 emits a BOM on Windows PowerShell 5.1, so write bytes.
function Write-JsonFile {
    param([string]$Path, [object]$Object)
    $json = $Object | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

# Is this policy Principal "public" (a bare '*' anywhere)? Handles "*", {AWS:"*"},
# and {AWS:["*", ...]} shapes. Used to strip public-read grants from the bucket.
function Test-PublicPrincipal {
    param($Principal)
    if ($null -eq $Principal) { return $false }
    if ($Principal -is [string]) { return ($Principal -eq '*') }
    foreach ($propName in $Principal.PSObject.Properties.Name) {
        foreach ($v in @($Principal.$propName)) { if ($v -eq '*') { return $true } }
    }
    return $false
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

# Like Invoke-Aws but returns $null (instead of throwing) when the failure is an
# EXPECTED "absent" condition, e.g. a bucket with no policy or no public-access
# block yet. Any other failure still throws via Invoke-Aws.
function Invoke-AwsAllowAbsent {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [string]$AbsentPattern,
        [string]$What,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs
    )
    try {
        return (Invoke-Aws -What $What @CliArgs)
    } catch {
        if ($AbsentPattern -and ($_.Exception.Message -match $AbsentPattern)) { return $null }
        throw
    }
}
#endregion

# ------------------------------------------------------------------------------
# Failure trap: name the phase, show the underlying error, exit non-zero.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  ENABLE CLOUDFRONT OAC FAILED' -ForegroundColor Red
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
    Write-Host "  Backups (if created): $ArtifactDir\oac-$DistributionId-*.json" -ForegroundColor Yellow
    Write-Host '  Rollback notes:' -ForegroundColor Yellow
    Write-Host '    - Distribution: update-distribution with the saved ORIGINAL config + ETag.' -ForegroundColor DarkGray
    Write-Host '    - Bucket policy: put-bucket-policy with the saved ORIGINAL policy (or' -ForegroundColor DarkGray
    Write-Host '      delete-bucket-policy if there was none originally).' -ForegroundColor DarkGray
    Write-Host '    - Block Public Access: put-public-access-block with the saved ORIGINAL.' -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}

# ==============================================================================
# PRE-FLIGHT
# ==============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity + distribution + bucket checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No OAC, CloudFront, or S3 changes will be made.'
} else {
    Write-Step 'LIVE MODE: this run will create an OAC, update the distribution, and lock the bucket.'
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

Write-Step "Confirming CloudFront distribution '$DistributionId' exists..."
$distMeta = Invoke-Aws -Retries 3 -DelaySeconds 5 `
    cloudfront get-distribution --id $DistributionId --output json | ConvertFrom-Json
Write-Diag "domain : $($distMeta.Distribution.DomainName)"
Write-Diag "status : $($distMeta.Distribution.Status)"
Write-Diag "enabled: $($distMeta.Distribution.DistributionConfig.Enabled)"

Write-Step "Confirming S3 bucket '$FrontendBucket' exists (region $Region)..."
Invoke-Aws -Retries 3 -DelaySeconds 5 -What "head-bucket $FrontendBucket" `
    s3api head-bucket --bucket $FrontendBucket --region $Region | Out-Null
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Create (or reuse) the Origin Access Control
# ==============================================================================
Write-Phase 'PHASE 1: Create or reuse the Origin Access Control (OAC)'

Write-Step "Looking for an existing OAC named '$OacName'..."
$oacListJson = Invoke-Aws -Retries 3 -DelaySeconds 5 `
    cloudfront list-origin-access-controls --output json
$oacExisting = $null
if ($oacListJson) {
    $oacList = $oacListJson | ConvertFrom-Json
    if ($oacList.OriginAccessControlList.PSObject.Properties.Name -contains 'Items') {
        $oacExisting = @($oacList.OriginAccessControlList.Items | Where-Object { $_.Name -eq $OacName })
        $oacExisting = if ($oacExisting.Count -gt 0) { $oacExisting[0] } else { $null }
    }
}

if ($oacExisting) {
    $OacId = $oacExisting.Id
    Write-Ok "OAC '$OacName' already exists; reusing it."
    Write-Diag "id   : $OacId"
    Write-Diag "type : $($oacExisting.OriginAccessControlOriginType)  signing: $($oacExisting.SigningBehavior)/$($oacExisting.SigningProtocol)"
} else {
    # OAC config: SigV4 + always-sign is the standard, recommended S3 OAC setup.
    $oacConfig = [ordered]@{
        Name                          = $OacName
        Description                   = $OacDescription
        SigningProtocol               = 'sigv4'
        SigningBehavior               = 'always'
        OriginAccessControlOriginType = 's3'
    }
    $oacConfigFile = Join-Path $ArtifactDir "oac-$DistributionId-config-$Stamp.json"
    Write-JsonFile -Path $oacConfigFile -Object $oacConfig
    Write-Step "Wrote OAC config to $oacConfigFile"

    Confirm-Step "Create CloudFront OAC '$OacName' (type=s3, sigv4/always) now?"
    $oacCreateJson = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "create-origin-access-control $OacName" `
        cloudfront create-origin-access-control `
        --origin-access-control-config "file://$oacConfigFile" `
        --output json

    if ($DryRun) {
        Write-Ok '[DRY-RUN] would create the OAC and capture its Id.'
        $OacId = 'DRYRUNOAC0000'
    } else {
        $OacId = ($oacCreateJson | ConvertFrom-Json).OriginAccessControl.Id
        if ([string]::IsNullOrEmpty($OacId)) { throw 'create-origin-access-control did not return an OAC Id.' }
        Write-Ok "Created OAC '$OacName'."
        Write-Diag "id : $OacId"
    }
}

# ==============================================================================
# PHASE 2 - Attach the OAC to the s3-frontend origin (atomic) + wait for deploy
# ==============================================================================
Write-Phase 'PHASE 2: Attach OAC to the s3-frontend origin (atomic, --if-match)'

$rawConfig = Invoke-Aws -Retries 3 -DelaySeconds 5 `
    cloudfront get-distribution-config --id $DistributionId --output json
$configEnvelope = $rawConfig | ConvertFrom-Json
$ETag   = $configEnvelope.ETag
$config = $configEnvelope.DistributionConfig
if ([string]::IsNullOrEmpty($ETag)) { throw 'Could not read the distribution ETag; aborting.' }
Write-Step "Current ETag: $ETag"

$backupConfig = Join-Path $ArtifactDir "oac-$DistributionId-ORIGINAL-config-$Stamp.json"
[System.IO.File]::WriteAllText($backupConfig, $rawConfig, [System.Text.UTF8Encoding]::new($false))
Write-Ok "Original distribution config saved to $backupConfig"

$origins = @($config.Origins.Items)
if ($origins.Count -eq 0) { throw 'Distribution has no origins; nothing to attach OAC to.' }
$target = @($origins | Where-Object { $_.Id -eq $OriginId })
if ($target.Count -eq 0) { throw "No origin with Id '$OriginId' found. Origins present: $((@($origins | ForEach-Object { $_.Id })) -join ', ')" }
if ($target.Count -gt 1) { throw "Multiple origins share Id '$OriginId'. Refusing to guess." }
$origin = $target[0]

$hasS3Config     = $origin.PSObject.Properties.Name -contains 'S3OriginConfig'
$hasCustomConfig = $origin.PSObject.Properties.Name -contains 'CustomOriginConfig'
$currentOac      = if ($origin.PSObject.Properties.Name -contains 'OriginAccessControlId') { [string]$origin.OriginAccessControlId } else { '' }

Write-Step "Current '$OriginId' origin:"
Write-Diag "domain : $($origin.DomainName)"
Write-Diag "type   : $(if ($hasS3Config) {'S3OriginConfig'} elseif ($hasCustomConfig) {'CustomOriginConfig'} else {'unknown'})"
Write-Diag "oac    : $(if ($currentOac) { $currentOac } else { '(none)' })"

# Idempotency: REST endpoint + S3OriginConfig + already this OAC -> nothing to do.
$alreadyAttached = ($origin.DomainName -eq $RestEndpoint) -and $hasS3Config -and (-not $hasCustomConfig) -and ($currentOac -eq $OacId)

if ($alreadyAttached) {
    Write-Ok "Origin '$OriginId' already uses OAC '$OacId' on the S3 REST endpoint. No CloudFront change needed."
    $skipDistUpdate = $true
} else {
    $skipDistUpdate = $false

    # Normalize to the S3 REST endpoint with S3OriginConfig (mirrors fix-cloudfront-s3-origin.ps1).
    $origin.DomainName = $RestEndpoint
    Write-Step "Set DomainName -> $RestEndpoint"
    if ($hasCustomConfig) {
        $origin.PSObject.Properties.Remove('CustomOriginConfig')
        Write-Step 'Removed CustomOriginConfig (mutually exclusive with S3OriginConfig).'
    }
    # OAC requires S3OriginConfig.OriginAccessIdentity = "" (OAI must be empty).
    $s3OriginConfig = [pscustomobject]@{ OriginAccessIdentity = '' }
    if ($hasS3Config) { $origin.S3OriginConfig = $s3OriginConfig }
    else { $origin | Add-Member -NotePropertyName 'S3OriginConfig' -NotePropertyValue $s3OriginConfig -Force }
    Write-Step 'Set S3OriginConfig.OriginAccessIdentity = "" (required with OAC).'

    # The actual attach: point the origin at our OAC id.
    if ($origin.PSObject.Properties.Name -contains 'OriginAccessControlId') { $origin.OriginAccessControlId = $OacId }
    else { $origin | Add-Member -NotePropertyName 'OriginAccessControlId' -NotePropertyValue $OacId -Force }
    Write-Step "Set OriginAccessControlId -> $OacId"

    $defaultTarget = $config.DefaultCacheBehavior.TargetOriginId
    if ($defaultTarget -ne $OriginId) {
        Write-Warn "Default cache behavior targets '$defaultTarget', not '$OriginId'. Leaving it unchanged."
    } else {
        Write-Ok "Default cache behavior correctly targets '$OriginId'."
    }

    $updatedConfigFile = Join-Path $ArtifactDir "oac-$DistributionId-UPDATED-config-$Stamp.json"
    Write-JsonFile -Path $updatedConfigFile -Object $config
    Write-Step "Wrote updated distribution config to $updatedConfigFile"

    Confirm-Step "Attach OAC '$OacName' to origin '$OriginId' on distribution '$DistributionId' now?"
    $updateResult = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "update-distribution $DistributionId" `
        cloudfront update-distribution `
        --id $DistributionId `
        --distribution-config "file://$updatedConfigFile" `
        --if-match $ETag `
        --output json

    if (-not $DryRun) {
        $updated   = $updateResult | ConvertFrom-Json
        $newOrigin = @(@($updated.Distribution.DistributionConfig.Origins.Items) | Where-Object { $_.Id -eq $OriginId })[0]
        $newOac    = if ($newOrigin.PSObject.Properties.Name -contains 'OriginAccessControlId') { [string]$newOrigin.OriginAccessControlId } else { '' }
        Write-Ok "Distribution updated. New ETag: $($updated.ETag)"
        Write-Diag "origin '$OriginId' OAC now: $newOac"
        if ($newOac -ne $OacId) { throw "Post-update verification failed: OriginAccessControlId is '$newOac' (expected '$OacId')." }
    } else {
        Write-Ok "[DRY-RUN] would update-distribution to attach the OAC with --if-match $ETag."
    }

    # Wait for full deployment BEFORE locking the bucket, so no edge is left doing
    # an unsigned read that the tightened policy would then reject (avoids 403s).
    if ($DryRun) {
        Write-Ok '[DRY-RUN] would wait for Status=Deployed before tightening the bucket policy.'
    } else {
        Write-Step 'Waiting for Status=Deployed before locking the bucket (usually a few minutes)...'
        Invoke-Aws -Retries 2 -DelaySeconds 10 -What "wait distribution-deployed $DistributionId" `
            cloudfront wait distribution-deployed --id $DistributionId
        Write-Ok 'Distribution finished deploying (Status=Deployed).'
    }
}

# ==============================================================================
# PHASE 3 - Lock the S3 bucket policy to this CloudFront distribution (OAC) only
# ==============================================================================
Write-Phase 'PHASE 3: Restrict the S3 bucket policy to CloudFront (OAC) only'

# Read the current policy (may not exist -> treat as empty). NoSuchBucketPolicy
# is the expected "absent" error; anything else (e.g. AccessDenied) still throws.
$curPolicyRaw = Invoke-AwsAllowAbsent -AbsentPattern 'NoSuchBucketPolicy' -What "get-bucket-policy $FrontendBucket" `
    s3api get-bucket-policy --bucket $FrontendBucket --region $Region --output json
$existingStatements = @()
$policyVersion = '2012-10-17'
if ($curPolicyRaw) {
    $curPolicyDoc = (($curPolicyRaw | ConvertFrom-Json).Policy) | ConvertFrom-Json
    if ($curPolicyDoc.PSObject.Properties.Name -contains 'Version' -and $curPolicyDoc.Version) { $policyVersion = $curPolicyDoc.Version }
    if ($curPolicyDoc.PSObject.Properties.Name -contains 'Statement') { $existingStatements = @($curPolicyDoc.Statement) }
    Write-Step "Current bucket policy has $($existingStatements.Count) statement(s)."

    $backupPolicy = Join-Path $ArtifactDir "oac-$FrontendBucket-ORIGINAL-policy-$Stamp.json"
    [System.IO.File]::WriteAllText($backupPolicy, ($curPolicyRaw | ConvertFrom-Json).Policy, [System.Text.UTF8Encoding]::new($false))
    Write-Ok "Original bucket policy saved to $backupPolicy"
} else {
    Write-Step 'Bucket currently has NO bucket policy.'
}

# The CloudFront-only read grant: the CloudFront service principal may GetObject,
# but ONLY when the request originates from THIS distribution (AWS:SourceArn).
$oacStatement = [ordered]@{
    Sid       = $BucketPolicySid
    Effect    = 'Allow'
    Principal = [ordered]@{ Service = 'cloudfront.amazonaws.com' }
    Action    = 's3:GetObject'
    Resource  = "arn:aws:s3:::$FrontendBucket/*"
    Condition = [ordered]@{ StringEquals = [ordered]@{ 'AWS:SourceArn' = $DistributionArn } }
}

# Keep statements that are NOT ours and NOT public Allow grants; drop the rest.
# Removing public (Principal '*') Allow statements is what makes the bucket
# private ("CloudFront only"); other targeted grants (e.g. a deploy role) survive.
$droppedPublic = @()
$keptStatements = @()
foreach ($s in $existingStatements) {
    $isOurs = ($s.PSObject.Properties.Name -contains 'Sid') -and ($s.Sid -eq $BucketPolicySid)
    $isPublicAllow = ($s.PSObject.Properties.Name -contains 'Effect') -and ($s.Effect -eq 'Allow') -and `
                     ($s.PSObject.Properties.Name -contains 'Principal') -and (Test-PublicPrincipal $s.Principal)
    if ($isOurs) { continue }
    if ($isPublicAllow) { $droppedPublic += $s; continue }
    $keptStatements += $s
}
if ($droppedPublic.Count -gt 0) {
    Write-Warn "Removing $($droppedPublic.Count) PUBLIC (Principal '*') Allow statement(s) to make the bucket private:"
    foreach ($d in $droppedPublic) {
        $sid = if ($d.PSObject.Properties.Name -contains 'Sid') { $d.Sid } else { '(no Sid)' }
        Write-Diag "dropped public statement: Sid='$sid' Action='$($d.Action)'"
    }
}

$mergedStatements = @($keptStatements) + @($oacStatement)
$newPolicy = [ordered]@{ Version = $policyVersion; Statement = $mergedStatements }

$policyFile = Join-Path $ArtifactDir "oac-$FrontendBucket-policy-$Stamp.json"
Write-JsonFile -Path $policyFile -Object $newPolicy
Write-Step "Wrote proposed bucket policy to $policyFile"

# No-op detection: compare normalized (sorted, compact) old vs new statement sets.
function ConvertTo-Normalized { param($Obj) ($Obj | ConvertTo-Json -Depth 50 -Compress) }
$oldNorm = ConvertTo-Normalized (@($existingStatements) | Sort-Object { ConvertTo-Normalized $_ })
$newNorm = ConvertTo-Normalized (@($mergedStatements)  | Sort-Object { ConvertTo-Normalized $_ })

if ($oldNorm -eq $newNorm) {
    Write-Ok 'Bucket policy already restricts access to this CloudFront distribution (unchanged). Skipping put.'
} else {
    Confirm-Step "Replace the bucket policy on '$FrontendBucket' with the CloudFront-only policy now?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-bucket-policy $FrontendBucket" `
        s3api put-bucket-policy --bucket $FrontendBucket --region $Region --policy "file://$policyFile" | Out-Null
    if (-not $DryRun) { Write-Ok 'Bucket policy updated: CloudFront (OAC) read-only access.' }
    else { Write-Ok '[DRY-RUN] would put the CloudFront-only bucket policy above.' }
}

# ==============================================================================
# PHASE 4 - Enable S3 Block Public Access (all four settings)
# ==============================================================================
Write-Phase 'PHASE 4: Enable S3 Block Public Access (all four settings)'

# Our OAC policy is NOT public (Service principal + SourceArn), so turning on
# BlockPublicPolicy / RestrictPublicBuckets does NOT lock CloudFront out.
$curBpaRaw = Invoke-AwsAllowAbsent -AbsentPattern 'NoSuchPublicAccessBlockConfiguration' -What "get-public-access-block $FrontendBucket" `
    s3api get-public-access-block --bucket $FrontendBucket --region $Region --output json
$bpaAllOn = $false
if ($curBpaRaw) {
    $bpa = ($curBpaRaw | ConvertFrom-Json).PublicAccessBlockConfiguration
    $bpaAllOn = $bpa.BlockPublicAcls -and $bpa.IgnorePublicAcls -and $bpa.BlockPublicPolicy -and $bpa.RestrictPublicBuckets
    Write-Diag "current BPA: BlockPublicAcls=$($bpa.BlockPublicAcls) IgnorePublicAcls=$($bpa.IgnorePublicAcls) BlockPublicPolicy=$($bpa.BlockPublicPolicy) RestrictPublicBuckets=$($bpa.RestrictPublicBuckets)"

    $backupBpa = Join-Path $ArtifactDir "oac-$FrontendBucket-ORIGINAL-bpa-$Stamp.json"
    [System.IO.File]::WriteAllText($backupBpa, $curBpaRaw, [System.Text.UTF8Encoding]::new($false))
    Write-Ok "Original public-access-block saved to $backupBpa"
} else {
    Write-Step 'Bucket currently has NO public-access-block configuration.'
}

if ($bpaAllOn) {
    Write-Ok 'Block Public Access already fully enabled (all four settings true). Skipping.'
} else {
    Confirm-Step "Enable S3 Block Public Access (all four settings) on '$FrontendBucket' now?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-public-access-block $FrontendBucket" `
        s3api put-public-access-block --bucket $FrontendBucket --region $Region `
        --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" | Out-Null
    if (-not $DryRun) { Write-Ok 'Block Public Access enabled (all four settings).' }
    else { Write-Ok '[DRY-RUN] would enable all four Block Public Access settings.' }
}

# ==============================================================================
# PHASE 5 - Verify CloudFront still serves 200 (and the bucket is now private)
# ==============================================================================
Write-Phase 'PHASE 5: Verify CloudFront serves 200 and direct S3 access is blocked'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: read-only checks + OAC/config/policy documents validated.'
    Write-Warn 'No OAC, distribution, bucket policy, or Block Public Access changes were made.'
    Write-Host ''
    Write-Step 'Re-run without -DryRun to apply.'
    Write-Host ''
    return
}

$maxProbe   = 6
$probeDelay = 15
$ok200      = $false
for ($i = 1; $i -le $maxProbe; $i++) {
    Write-Step "Probing $CloudFrontUrl (attempt $i/$maxProbe)..."
    try {
        $resp = Invoke-WebRequest -Uri $CloudFrontUrl -UseBasicParsing -TimeoutSec 30
        Write-Diag "HTTP $($resp.StatusCode)  (content-length: $($resp.RawContentLength))"
        if ($resp.StatusCode -eq 200) { $ok200 = $true; break }
        Write-Warn "Endpoint returned $($resp.StatusCode); retrying in $probeDelay s..."
    } catch {
        $code = $null
        if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) {
            try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = $null }
        }
        if ($code) { Write-Warn "Endpoint returned HTTP $code; retrying in $probeDelay s..." }
        else       { Write-Warn "Probe failed: $($_.Exception.Message); retrying in $probeDelay s..." }
    }
    if ($i -lt $maxProbe) { Start-Sleep -Seconds $probeDelay }
}

if (-not $ok200) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  ENDPOINT DID NOT RETURN 200' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Warn "OAC + bucket lock-down were applied, but $CloudFrontUrl did not return 200."
    Write-Warn 'Common causes: distribution still propagating, or the bucket policy SourceArn'
    Write-Warn 'does not match this distribution ARN. Try invalidating the cache and re-checking:'
    Write-Diag "aws cloudfront create-invalidation --distribution-id $DistributionId --paths '/*'"
    Write-Diag "expected SourceArn: $DistributionArn"
    Write-Warn 'Rollback: restore the saved ORIGINAL distribution config / bucket policy / BPA.'
    throw "Verification failed: $CloudFrontUrl did not return HTTP 200."
}
Write-Ok "CloudFront endpoint returned 200 (OAC read path works)."

# Soft check: a direct public GET to the S3 REST endpoint should now be FORBIDDEN.
Write-Step "Confirming direct public S3 access is now blocked: $DirectS3Url"
try {
    $direct = Invoke-WebRequest -Uri $DirectS3Url -UseBasicParsing -TimeoutSec 30
    Write-Warn "Direct S3 GET unexpectedly returned HTTP $($direct.StatusCode). The bucket may still be public; re-check the policy / BPA."
} catch {
    $dcode = $null
    if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) {
        try { $dcode = [int]$_.Exception.Response.StatusCode } catch { $dcode = $null }
    }
    if ($dcode -eq 403) { Write-Ok 'Direct public S3 access is blocked (HTTP 403). Bucket is private.' }
    elseif ($dcode)     { Write-Diag "Direct S3 GET returned HTTP $dcode (not 200 = not publicly readable)." }
    else                { Write-Diag "Direct S3 GET failed at the network layer (not publicly readable): $($_.Exception.Message)" }
}

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: CloudFront S3 origin is now locked behind OAC (private bucket)' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  distribution : $DistributionId" -ForegroundColor Green
Write-Host "  origin       : $OriginId -> $RestEndpoint (S3OriginConfig)" -ForegroundColor Green
Write-Host "  oac          : $OacName ($OacId)" -ForegroundColor Green
Write-Host "  bucket       : $FrontendBucket (CloudFront-only, Block Public Access ON)" -ForegroundColor Green
Write-Host "  endpoint     : $CloudFrontUrl -> HTTP 200" -ForegroundColor Green
Write-Host ''
Write-Host '  Saved documents (audit / rollback):' -ForegroundColor Yellow
Write-Host "    original config : $backupConfig" -ForegroundColor DarkGray
Write-Host "    bucket policy   : $policyFile" -ForegroundColor DarkGray
Write-Host ''
Write-Ok 'CloudFront OAC enablement complete.'

