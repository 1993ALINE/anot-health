<#
================================================================================
 fix-cloudfront-s3-origin.ps1  -  Repoint the CloudFront SPA origin from the S3
                                  WEBSITE endpoint to the S3 REST endpoint
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 THE PROBLEM THIS FIXES:
   The CloudFront distribution (E6SKNV1EEXNPP) serves the React SPA from an S3
   origin whose DomainName is the S3 *website* endpoint:
       anot-frontend-625242092266.s3-website-ap-southeast-1.amazonaws.com
   configured as a CustomOriginConfig (plain HTTP to the website endpoint).
   S3 website endpoints behind CloudFront are second-class: HTTP-only origin,
   no SSE/SigV4, no OAC/OAI, weaker error handling, and they routinely cause
   intermittent 5xx/origin errors. The REST endpoint is the supported origin.

 THE FIX:
   Rewrite the 's3-frontend' origin to the S3 *REST* endpoint:
       anot-frontend-625242092266.s3.ap-southeast-1.amazonaws.com
   and switch the origin from CustomOriginConfig to S3OriginConfig. We set
   S3OriginConfig.OriginAccessIdentity = "" (empty) which means "public bucket,
   no OAI". This works as long as the bucket policy still allows public reads
   (which it must already, since the website endpoint was public). OAC is the
   more secure long-term option; see the note printed at the end.

 WHAT THIS SCRIPT DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks; confirm the distribution exists.
   Phase 1     get-distribution-config (captures the ETag for the atomic update).
   Phase 2     Locate the 's3-frontend' origin and rewrite it:
                 - DomainName  -> REST endpoint
                 - remove CustomOriginConfig
                 - add S3OriginConfig (OriginAccessIdentity = "")
               Confirm the default cache behavior still targets 's3-frontend'.
   Phase 3     update-distribution atomically with --if-match <ETag>.
   Phase 4     Wait for the distribution to finish deploying (Deployed status).
   Phase 5     Probe https://d3t0m4s0ayca85.cloudfront.net/ and assert HTTP 200.

 SAFETY:
   * The original distribution config is saved to disk BEFORE any change, so a
     rollback is just: update-distribution with the saved config + its ETag.
   * The update is atomic (--if-match) - if anyone else changed the distribution
     between read and write, AWS rejects our stale write instead of clobbering.
   * Idempotent: if 's3-frontend' is already a REST + S3OriginConfig origin, the
     script reports "already correct" and skips the mutating update.
   * -DryRun does every read-only step and prints the exact diff WITHOUT calling
     update-distribution.

 USAGE:
   pwsh -File scripts/fix-cloudfront-s3-origin.ps1 -DryRun   # rehearse, no change
   pwsh -File scripts/fix-cloudfront-s3-origin.ps1           # apply (prompts)
   pwsh -File scripts/fix-cloudfront-s3-origin.ps1 -Force    # apply, no prompts
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
$Region          = 'ap-southeast-1'
$DistributionId  = 'E6SKNV1EEXNPP'
$OriginId        = 's3-frontend'
$FrontendBucket  = "anot-frontend-$AwsAccountId"

# The two endpoints. We are migrating FROM the website endpoint TO the REST one.
$WebsiteEndpoint = "$FrontendBucket.s3-website-$Region.amazonaws.com"
$RestEndpoint    = "$FrontendBucket.s3.$Region.amazonaws.com"

# Public test target (CloudFront default domain for this distribution).
$CloudFrontUrl   = 'https://d3t0m4s0ayca85.cloudfront.net/'

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'

# CloudFront is a GLOBAL service - its control-plane API only lives in us-east-1.
# Pin the region for every aws call in this session, and disable the v2 pager.
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
#endregion

# ------------------------------------------------------------------------------
# Failure trap: name the phase, show the underlying error, exit non-zero.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  CLOUDFRONT ORIGIN FIX FAILED' -ForegroundColor Red
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
    Write-Host "  Backups (if created): $ArtifactDir\cloudfront-$DistributionId-*.json" -ForegroundColor Yellow
    Write-Host "  Manual rollback:" -ForegroundColor Yellow
    Write-Host "    aws cloudfront update-distribution --id $DistributionId \\" -ForegroundColor DarkGray
    Write-Host "      --distribution-config file://`<saved-config`>.json --if-match `<saved-ETag`>" -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}

# ==============================================================================
# PRE-FLIGHT
# ==============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity + distribution checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No CloudFront changes will be made.'
} else {
    Write-Step 'LIVE MODE: this run will update the CloudFront distribution.'
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
$liveDomain = $distMeta.Distribution.DomainName
Write-Diag "domain : $liveDomain"
Write-Diag "status : $($distMeta.Distribution.Status)"
Write-Diag "enabled: $($distMeta.Distribution.DistributionConfig.Enabled)"
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Read the distribution config (capture the ETag for the atomic update)
# ==============================================================================
Write-Phase 'PHASE 1: Read distribution config (capture ETag)'

# get-distribution-config returns { ETag, DistributionConfig }. The ETag is the
# concurrency token: update-distribution must echo it back via --if-match or AWS
# rejects the write. We keep the raw JSON (high -Depth) so the round-trip through
# ConvertFrom/ConvertTo-Json does not silently drop nested fields.
$rawConfig = Invoke-Aws -Retries 3 -DelaySeconds 5 `
    cloudfront get-distribution-config --id $DistributionId --output json
$configEnvelope = $rawConfig | ConvertFrom-Json
$ETag   = $configEnvelope.ETag
$config = $configEnvelope.DistributionConfig
if ([string]::IsNullOrEmpty($ETag)) { throw 'Could not read the distribution ETag; aborting.' }
Write-Step "Current ETag: $ETag"

# Save the ORIGINAL config (envelope + extracted config) before any change, so a
# rollback is a single update-distribution call with the saved config + ETag.
$backupEnvelope = Join-Path $ArtifactDir "cloudfront-$DistributionId-ORIGINAL-$Stamp.json"
$rawConfig | Out-File -FilePath $backupEnvelope -Encoding utf8
Write-Ok "Original distribution config saved to $backupEnvelope"

# ==============================================================================
# PHASE 2 - Rewrite the 's3-frontend' origin (website -> REST, Custom -> S3)
# ==============================================================================
Write-Phase 'PHASE 2: Rewrite the s3-frontend origin'

$origins = @($config.Origins.Items)
if ($origins.Count -eq 0) { throw 'Distribution has no origins; nothing to fix.' }

Write-Step "Distribution has $($config.Origins.Quantity) origin(s):"
foreach ($o in $origins) {
    $kind = if ($o.PSObject.Properties.Name -contains 'S3OriginConfig')     { 'S3OriginConfig' }
            elseif ($o.PSObject.Properties.Name -contains 'CustomOriginConfig') { 'CustomOriginConfig' }
            else { 'unknown' }
    Write-Diag "id='$($o.Id)'  domain='$($o.DomainName)'  type=$kind"
}

$target = $origins | Where-Object { $_.Id -eq $OriginId }
$target = @($target)
if ($target.Count -eq 0) { throw "No origin with Id '$OriginId' found. Origins present: $((@($origins | ForEach-Object { $_.Id })) -join ', ')" }
if ($target.Count -gt 1) { throw "Multiple origins share Id '$OriginId' ($($target.Count)). Refusing to guess." }
$origin = $target[0]

$hasS3Config     = $origin.PSObject.Properties.Name -contains 'S3OriginConfig'
$hasCustomConfig = $origin.PSObject.Properties.Name -contains 'CustomOriginConfig'

Write-Step "Current '$OriginId' origin:"
Write-Diag "domain : $($origin.DomainName)"
Write-Diag "type   : $(if ($hasS3Config) {'S3OriginConfig'} elseif ($hasCustomConfig) {'CustomOriginConfig'} else {'unknown'})"

# Idempotency: already a REST endpoint AND already an S3OriginConfig -> done.
$alreadyRest      = ($origin.DomainName -eq $RestEndpoint)
$alreadyCorrect   = $alreadyRest -and $hasS3Config -and (-not $hasCustomConfig)

if ($alreadyCorrect) {
    Write-Ok "Origin '$OriginId' is ALREADY the REST endpoint with S3OriginConfig. No change needed."
} else {
    if ($origin.DomainName -ne $WebsiteEndpoint -and -not $alreadyRest) {
        Write-Warn "Origin DomainName is '$($origin.DomainName)', which is neither the known website endpoint"
        Write-Warn "($WebsiteEndpoint) nor the REST endpoint. Proceeding to set it to the REST endpoint anyway."
    }

    # 1) Point the origin at the REST endpoint.
    $origin.DomainName = $RestEndpoint
    Write-Step "Set DomainName -> $RestEndpoint"

    # 2) Drop CustomOriginConfig if present (mutually exclusive with S3OriginConfig).
    if ($hasCustomConfig) {
        $origin.PSObject.Properties.Remove('CustomOriginConfig')
        Write-Step 'Removed CustomOriginConfig.'
    }

    # 3) Add (or normalize) S3OriginConfig. Empty OriginAccessIdentity = public
    #    bucket, no OAI. (OAC is configured via the origin-level
    #    OriginAccessControlId, which we leave empty here = none.)
    $s3OriginConfig = [pscustomobject]@{ OriginAccessIdentity = '' }
    if ($hasS3Config) {
        $origin.S3OriginConfig = $s3OriginConfig
        Write-Step 'Normalized S3OriginConfig (OriginAccessIdentity = "").'
    } else {
        $origin | Add-Member -NotePropertyName 'S3OriginConfig' -NotePropertyValue $s3OriginConfig -Force
        Write-Step 'Added S3OriginConfig (OriginAccessIdentity = "").'
    }

    # 4) For a REST/S3 origin, OriginAccessControlId must be a string (empty =
    #    none). Ensure the property exists so the config is well-formed.
    if ($origin.PSObject.Properties.Name -contains 'OriginAccessControlId') {
        if ($null -eq $origin.OriginAccessControlId) { $origin.OriginAccessControlId = '' }
    } else {
        $origin | Add-Member -NotePropertyName 'OriginAccessControlId' -NotePropertyValue '' -Force
    }
}

# Confirm the DEFAULT cache behavior still targets 's3-frontend' (the SPA origin).
$defaultTarget = $config.DefaultCacheBehavior.TargetOriginId
Write-Step "Default cache behavior TargetOriginId: '$defaultTarget'"
if ($defaultTarget -ne $OriginId) {
    Write-Warn "Default cache behavior targets '$defaultTarget', not '$OriginId'. Leaving it unchanged per spec,"
    Write-Warn 'but verify this is intentional - the SPA is expected to be served from the s3-frontend origin.'
} else {
    Write-Ok "Default cache behavior correctly targets '$OriginId'."
}

if ($alreadyCorrect) {
    Write-Phase 'NO CHANGE REQUIRED'
    Write-Ok 'The distribution already uses the S3 REST endpoint with S3OriginConfig.'
    Write-Step "Verifying the public endpoint anyway: $CloudFrontUrl"
    try {
        $resp = Invoke-WebRequest -Uri $CloudFrontUrl -UseBasicParsing -TimeoutSec 30
        Write-Diag "HTTP $($resp.StatusCode)"
        if ($resp.StatusCode -eq 200) { Write-Ok "Endpoint returned 200." } else { Write-Warn "Endpoint returned $($resp.StatusCode)." }
    } catch {
        Write-Warn "Endpoint probe failed: $($_.Exception.Message)"
    }
    Write-Host ''
    return
}

# Serialize the MODIFIED config. -Depth 100 is essential: CloudFront configs are
# deeply nested (origins -> custom headers -> items, cache behaviors, etc.) and a
# shallow ConvertTo-Json silently truncates them into "System.Object[]" strings.
$updatedConfigFile = Join-Path $ArtifactDir "cloudfront-$DistributionId-UPDATED-$Stamp.json"
# AWS CLI's file:// parser rejects a UTF-8 BOM ("ParamValidation: Expected: '=', received: '∩'").
# Out-File -Encoding utf8 emits a BOM on Windows PowerShell, so write the bytes directly
# with a BOM-less UTF-8 encoding instead.
$jsonString = $config | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($updatedConfigFile, $jsonString, [System.Text.UTF8Encoding]::new($false))
Write-Step "Wrote updated distribution config to $updatedConfigFile"

# ==============================================================================
# PHASE 3 - Apply the change atomically (--if-match <ETag>)
# ==============================================================================
Write-Phase 'PHASE 3: Update the distribution (atomic, --if-match)'

Confirm-Step "Update distribution '$DistributionId' origin '$OriginId' to the S3 REST endpoint now?"

$updateResult = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "update-distribution $DistributionId" `
    cloudfront update-distribution `
    --id $DistributionId `
    --distribution-config "file://$updatedConfigFile" `
    --if-match $ETag `
    --output json

if (-not $DryRun) {
    $updated = $updateResult | ConvertFrom-Json
    $newETag = $updated.ETag
    $newOrigin = @(@($updated.Distribution.DistributionConfig.Origins.Items) | Where-Object { $_.Id -eq $OriginId })[0]
    Write-Ok "Distribution updated. New ETag: $newETag"
    Write-Diag "origin '$OriginId' domain now: $($newOrigin.DomainName)"
    $newIsS3 = $newOrigin.PSObject.Properties.Name -contains 'S3OriginConfig'
    Write-Diag "origin '$OriginId' type now  : $(if ($newIsS3) {'S3OriginConfig'} else {'(NOT S3OriginConfig!)'})"
    if ($newOrigin.DomainName -ne $RestEndpoint -or -not $newIsS3) {
        throw "Post-update verification failed: origin is '$($newOrigin.DomainName)' / S3OriginConfig=$newIsS3."
    }
} else {
    Write-Ok "[DRY-RUN] would update-distribution with the rewritten config and --if-match $ETag."
}

# ==============================================================================
# PHASE 4 - Wait for the distribution to finish deploying
# ==============================================================================
Write-Phase 'PHASE 4: Wait for the distribution to deploy'

if ($DryRun) {
    Write-Ok '[DRY-RUN] would wait for the distribution to reach Status=Deployed.'
} else {
    Write-Step 'Waiting for Status=Deployed (CloudFront propagation usually takes a few minutes)...'
    # The built-in waiter polls get-distribution until Status=Deployed (up to ~1h).
    Invoke-Aws -Retries 2 -DelaySeconds 10 -What "wait distribution-deployed $DistributionId" `
        cloudfront wait distribution-deployed --id $DistributionId
    Write-Ok 'Distribution finished deploying (Status=Deployed).'
}

# ==============================================================================
# PHASE 5 - Probe the public endpoint and assert HTTP 200
# ==============================================================================
Write-Phase 'PHASE 5: Verify the public endpoint returns 200'

if ($DryRun) {
    Write-Ok "DRY-RUN COMPLETE: read-only checks + config rewrite validated. No CloudFront changes were made."
    Write-Warn 'Re-run without -DryRun to apply the origin change.'
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
        # Invoke-WebRequest throws on non-2xx in some PS versions; surface the code if present.
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
    Write-Warn "The origin change was applied and the distribution is Deployed, but"
    Write-Warn "$CloudFrontUrl did not return 200 within $maxProbe probes."
    Write-Warn 'Most likely cause: the S3 bucket policy does not allow public reads on the'
    Write-Warn 'REST endpoint (the website endpoint and the REST endpoint enforce policy'
    Write-Warn 'differently). Check the bucket policy / Block Public Access:'
    Write-Diag "aws s3api get-bucket-policy --bucket $FrontendBucket"
    Write-Diag "aws s3api get-public-access-block --bucket $FrontendBucket"
    Write-Warn 'You can also invalidate the cache and retry:'
    Write-Diag "aws cloudfront create-invalidation --distribution-id $DistributionId --paths '/*'"
    Write-Warn "Rollback (restore the website-endpoint origin) using the saved config:"
    Write-Diag "  saved original: $backupEnvelope"
    throw "Verification failed: $CloudFrontUrl did not return HTTP 200."
}

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: s3-frontend now uses the S3 REST endpoint and serves 200' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  distribution : $DistributionId" -ForegroundColor Green
Write-Host "  origin       : $OriginId" -ForegroundColor Green
Write-Host "  domain       : $RestEndpoint (S3OriginConfig)" -ForegroundColor Green
Write-Host "  endpoint     : $CloudFrontUrl -> HTTP 200" -ForegroundColor Green
Write-Host ''
Write-Host '  Saved configs (for rollback / audit):' -ForegroundColor Yellow
Write-Host "    original: $backupEnvelope" -ForegroundColor DarkGray
Write-Host "    updated : $updatedConfigFile" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  RECOMMENDED NEXT STEP (security hardening): switch this origin to OAC' -ForegroundColor Yellow
Write-Host '  (Origin Access Control) and make the bucket private:' -ForegroundColor Yellow
Write-Host '    1. aws cloudfront create-origin-access-control ...' -ForegroundColor DarkGray
Write-Host '    2. Set the origin OriginAccessControlId to the new OAC id' -ForegroundColor DarkGray
Write-Host '    3. Restrict the bucket policy to the CloudFront service principal' -ForegroundColor DarkGray
Write-Host '       and re-enable S3 Block Public Access.' -ForegroundColor DarkGray
Write-Host ''
Write-Ok 'CloudFront S3 origin fix complete.'
