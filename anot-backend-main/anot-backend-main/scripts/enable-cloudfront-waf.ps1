<#
================================================================================
 enable-cloudfront-waf.ps1  -  Create and attach an AWS WAFv2 WebACL to the
                               CloudFront distribution E6SKNV1EEXNPP
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHAT THIS SCRIPT DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks; confirm the distribution exists.
   PHASE 1     Create (or reuse) a WAFv2 WebACL with scope=CLOUDFRONT:
                 - AWS Managed Rules: AWSManagedRulesCommonRuleSet
                 - Rate-based rule:   2000 requests / 5 min per source IP -> Block
                 - Optional custom rule: block obvious bad-bot URI probes
   PHASE 2     (Optional) Enable WAF logging to a CloudWatch Logs log group
                 named 'aws-waf-logs-*' (the required WAF logging prefix).
   PHASE 3     Attach the WebACL to the CloudFront distribution by setting
                 DistributionConfig.WebACLId = <WebACL ARN> and calling
                 update-distribution atomically (--if-match <ETag>).
   PHASE 4     Wait for the distribution to deploy, then verify WAF + logging.

 WHY CLOUDFRONT IS SPECIAL:
   * WAFv2 WebACLs for CloudFront use scope=CLOUDFRONT and ONLY live in
     us-east-1. Every wafv2 call here is pinned to us-east-1.
   * You CANNOT use 'wafv2 associate-web-acl' for CloudFront (that API is for
     regional resources like ALB/API Gateway). For CloudFront you attach the
     WebACL through the CloudFront API by writing its ARN into WebACLId and
     calling update-distribution. This script does exactly that.
   * WAF inspects REQUESTS, not responses, so it cannot natively block on a
     "403/404 response". The closest equivalent (and what is implemented as the
     optional rule) is blocking common malicious/scanner URI patterns BEFORE
     they ever reach the origin. See the BadUriPatterns rule below.

 SAFETY:
   * Idempotent: if a WebACL with the target name already exists it is reused;
     if the distribution already points at that WebACL the attach is skipped.
   * The CloudFront update is atomic (--if-match <ETag>) and the ORIGINAL
     distribution config is saved to disk before any change for easy rollback.
   * -DryRun does every read-only step and prints exactly what WOULD change
     WITHOUT creating the WebACL, enabling logging, or updating the distribution.

 USAGE:
   pwsh -File scripts/enable-cloudfront-waf.ps1 -DryRun   # rehearse, no change
   pwsh -File scripts/enable-cloudfront-waf.ps1           # apply (prompts)
   pwsh -File scripts/enable-cloudfront-waf.ps1 -Force    # apply, no prompts
   pwsh -File scripts/enable-cloudfront-waf.ps1 -NoLogging # skip WAF logging
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun,
    [switch]$NoLogging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId    = '625242092266'
$DistributionId  = 'E6SKNV1EEXNPP'

# WAFv2 WebACL identity. CLOUDFRONT-scoped WebACLs live ONLY in us-east-1.
$WebAclName      = 'anot-cloudfront-waf'
$WebAclScope     = 'CLOUDFRONT'
$WebAclMetric    = 'anotCloudfrontWaf'

# Rate limit: max requests per 5-minute sliding window per source IP.
$RateLimit       = 2000

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

# BOM-free UTF-8 write. The AWS CLI 'file://' parser rejects a UTF-8 BOM
# ("ParamValidation: Expected: '=', received: '...'"), and Out-File -Encoding
# utf8 emits a BOM on Windows PowerShell 5.1, so write the bytes directly.
function Write-JsonFile {
    param([string]$Path, [object]$Object)
    $json = $Object | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
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
    Write-Host '  ENABLE CLOUDFRONT WAF FAILED' -ForegroundColor Red
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
    Write-Host "  Artifacts (if created): $ArtifactDir\waf-$DistributionId-*.json" -ForegroundColor Yellow
    Write-Host "  To detach the WebACL from CloudFront: set DistributionConfig.WebACLId = ''" -ForegroundColor Yellow
    Write-Host "  and update-distribution with the saved ORIGINAL config + its ETag." -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

# ==============================================================================
# PRE-FLIGHT
# ==============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity + distribution checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No WAF or CloudFront changes will be made.'
} else {
    Write-Step 'LIVE MODE: this run will create/attach a WAF WebACL and update the distribution.'
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
$existingWebAclId = ''
if ($distMeta.Distribution.DistributionConfig.PSObject.Properties.Name -contains 'WebACLId') {
    $existingWebAclId = [string]$distMeta.Distribution.DistributionConfig.WebACLId
}
Write-Diag "current WebACLId: $(if ($existingWebAclId) { $existingWebAclId } else { '(none)' })"
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Create (or reuse) the WAFv2 WebACL
# ==============================================================================
Write-Phase 'PHASE 1: Create or reuse the WAFv2 WebACL'

# Idempotency: look for an existing WebACL with our target name in CLOUDFRONT scope.
Write-Step "Looking for an existing CLOUDFRONT WebACL named '$WebAclName'..."
$listJson = Invoke-Aws -Retries 3 -DelaySeconds 5 `
    wafv2 list-web-acls --scope $WebAclScope --output json
$existing = $null
if ($listJson) {
    $list = $listJson | ConvertFrom-Json
    if ($list.PSObject.Properties.Name -contains 'WebACLs') {
        $existing = @($list.WebACLs | Where-Object { $_.Name -eq $WebAclName })
        $existing = if ($existing.Count -gt 0) { $existing[0] } else { $null }
    }
}

# Rules document shared by create and (potential) update. NOTE the action keys:
#   - Managed rule groups use OverrideAction ({ None = {} } => keep group actions)
#   - Custom rules use Action ({ Block = {} } / { Allow = {} } / { Count = {} })
$rules = @(
    # 1) AWS Managed Rules: broad OWASP-style protection (XSS, LFI, bad inputs...).
    [ordered]@{
        Name      = 'AWS-AWSManagedRulesCommonRuleSet'
        Priority  = 1
        Statement = [ordered]@{
            ManagedRuleGroupStatement = [ordered]@{
                VendorName = 'AWS'
                Name       = 'AWSManagedRulesCommonRuleSet'
            }
        }
        OverrideAction  = [ordered]@{ None = @{} }
        VisibilityConfig = [ordered]@{
            SampledRequestsEnabled   = $true
            CloudWatchMetricsEnabled = $true
            MetricName               = 'AWSManagedRulesCommonRuleSet'
        }
    },
    # 2) Rate limiting: more than $RateLimit requests / 5 min from one IP -> Block.
    [ordered]@{
        Name      = 'RateLimitPerIP'
        Priority  = 2
        Statement = [ordered]@{
            RateBasedStatement = [ordered]@{
                Limit            = $RateLimit
                AggregateKeyType = 'IP'
            }
        }
        Action = [ordered]@{ Block = @{} }
        VisibilityConfig = [ordered]@{
            SampledRequestsEnabled   = $true
            CloudWatchMetricsEnabled = $true
            MetricName               = 'RateLimitPerIP'
        }
    },
    # 3) Optional custom rule. WAF inspects REQUESTS (not responses), so it cannot
    #    block on a 403/404 RESPONSE. Instead we block obvious scanner/probe URIs
    #    that almost always generate 403/404 noise from the origin (e.g. attempts
    #    to fetch .env, .git, wp-admin, phpMyAdmin). Tune or remove as needed.
    #
    #    IMPORTANT (base64): WAFv2 ByteMatchStatement.SearchString is a BLOB. When a
    #    blob is nested inside a JSON document passed via '--rules file://...', AWS
    #    CLI v2 (default cli_binary_format=base64) treats the value as ALREADY
    #    base64-encoded and decodes it. A plain string like '/phpmyadmin' is not
    #    valid base64, which produced "Invalid base64: /phpmyadmin". The CLI only
    #    auto-encodes blobs passed as a TOP-LEVEL parameter, not nested in a file.
    #    So we base64-encode each pattern ourselves; the service decodes it back to
    #    the original bytes and matches the raw URI path (after the LOWERCASE xform).
    [ordered]@{
        Name      = 'BlockBadUriProbes'
        Priority  = 3
        Statement = [ordered]@{
            OrStatement = [ordered]@{
                Statements = @(
                    '/.env', '/.git', '/wp-admin', '/wp-login', '/phpmyadmin', '/.aws' |
                    ForEach-Object {
                        [ordered]@{
                            ByteMatchStatement = [ordered]@{
                                SearchString         = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_))
                                FieldToMatch         = [ordered]@{ UriPath = @{} }
                                TextTransformations  = @(
                                    [ordered]@{ Priority = 0; Type = 'LOWERCASE' }
                                )
                                PositionalConstraint = 'CONTAINS'
                            }
                        }
                    }
                )
            }
        }
        Action = [ordered]@{ Block = @{} }
        VisibilityConfig = [ordered]@{
            SampledRequestsEnabled   = $true
            CloudWatchMetricsEnabled = $true
            MetricName               = 'BlockBadUriProbes'
        }
    }
)

$rulesFile = Join-Path $ArtifactDir "waf-$DistributionId-rules-$Stamp.json"
Write-JsonFile -Path $rulesFile -Object $rules
Write-Step "Wrote WebACL rules document to $rulesFile"

if ($existing) {
    $WebAclArn = $existing.ARN
    $WebAclId  = $existing.Id
    Write-Ok "WebACL '$WebAclName' already exists; reusing it."
    Write-Diag "id  : $WebAclId"
    Write-Diag "arn : $WebAclArn"
    Write-Step 'Skipping create (idempotent). Existing rules are left as-is.'
    Write-Diag 'To force a rule refresh, update the WebACL manually with wafv2 update-web-acl.'
} else {
    Write-Step "No existing WebACL named '$WebAclName'. It will be created with:"
    Write-Diag 'rule 1: AWSManagedRulesCommonRuleSet (AWS managed)'
    Write-Diag "rule 2: RateLimitPerIP ($RateLimit req / 5 min per IP -> Block)"
    Write-Diag 'rule 3: BlockBadUriProbes (.env/.git/wp-admin/... -> Block)'

    Confirm-Step "Create WAFv2 WebACL '$WebAclName' (scope=$WebAclScope) now?"

    $createJson = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "create-web-acl $WebAclName" `
        wafv2 create-web-acl `
        --name $WebAclName `
        --scope $WebAclScope `
        --default-action 'Allow={}' `
        --rules "file://$rulesFile" `
        --visibility-config "SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=$WebAclMetric" `
        --description 'WAF for anot CloudFront SPA: AWS managed rules + per-IP rate limiting + bad-URI blocking.' `
        --output json

    if ($DryRun) {
        Write-Ok "[DRY-RUN] would create the WebACL and capture its ARN/Id."
        $WebAclArn = "arn:aws:wafv2:us-east-1:${AwsAccountId}:global/webacl/$WebAclName/DRYRUN0000"
        $WebAclId  = 'DRYRUN0000'
    } else {
        $created   = $createJson | ConvertFrom-Json
        $WebAclArn = $created.Summary.ARN
        $WebAclId  = $created.Summary.Id
        if ([string]::IsNullOrEmpty($WebAclArn)) { throw 'create-web-acl did not return a WebACL ARN.' }
        Write-Ok "Created WebACL '$WebAclName'."
        Write-Diag "id  : $WebAclId"
        Write-Diag "arn : $WebAclArn"
    }
}

# ==============================================================================
# PHASE 2 - Enable WAF logging to CloudWatch Logs (optional)
# ==============================================================================
Write-Phase 'PHASE 2: Enable WAF logging (CloudWatch Logs)'

if ($NoLogging) {
    Write-Warn '-NoLogging specified: skipping WAF logging setup.'
} else {
    # The log group name MUST begin with 'aws-waf-logs-' or WAF rejects it. For a
    # CLOUDFRONT-scoped WebACL the log group must also live in us-east-1 (it does;
    # AWS_DEFAULT_REGION is pinned to us-east-1 above).
    Write-Step "Ensuring CloudWatch log group '$LogGroupName' exists..."
    $lgJson = Invoke-Aws -Retries 3 -DelaySeconds 5 `
        logs describe-log-groups --log-group-name-prefix $LogGroupName --output json
    $haveLg = $false
    if ($lgJson) {
        $lg = $lgJson | ConvertFrom-Json
        $haveLg = @($lg.logGroups | Where-Object { $_.logGroupName -eq $LogGroupName }).Count -gt 0
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
    }

    # WAF logging-configuration wants the log group ARN WITHOUT a trailing ':*'.
    $LogGroupArn = "arn:aws:logs:us-east-1:${AwsAccountId}:log-group:$LogGroupName"
    Write-Step "Associating WebACL logging -> $LogGroupArn"

    $loggingConfig = [ordered]@{
        ResourceArn          = $WebAclArn
        LogDestinationConfigs = @($LogGroupArn)
    }
    $loggingFile = Join-Path $ArtifactDir "waf-$DistributionId-logging-$Stamp.json"
    Write-JsonFile -Path $loggingFile -Object $loggingConfig

    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-logging-configuration $WebAclName" `
        wafv2 put-logging-configuration `
        --logging-configuration "file://$loggingFile" `
        --output json | Out-Null
    if (-not $DryRun) { Write-Ok 'WAF logging enabled.' }
    else { Write-Ok '[DRY-RUN] would enable WAF logging to the log group above.' }
}

# ==============================================================================
# PHASE 3 - Attach the WebACL to the CloudFront distribution (atomic)
# ==============================================================================
Write-Phase 'PHASE 3: Attach the WebACL to CloudFront (atomic, --if-match)'

# Read the live distribution config + ETag (the concurrency token for the write).
$rawConfig = Invoke-Aws -Retries 3 -DelaySeconds 5 `
    cloudfront get-distribution-config --id $DistributionId --output json
$configEnvelope = $rawConfig | ConvertFrom-Json
$ETag   = $configEnvelope.ETag
$config = $configEnvelope.DistributionConfig
if ([string]::IsNullOrEmpty($ETag)) { throw 'Could not read the distribution ETag; aborting.' }
Write-Step "Current ETag: $ETag"

# Save the ORIGINAL config before any change, so a rollback / detach is a single
# update-distribution call with the saved config + ETag.
$backupEnvelope = Join-Path $ArtifactDir "waf-$DistributionId-ORIGINAL-$Stamp.json"
[System.IO.File]::WriteAllText($backupEnvelope, $rawConfig, [System.Text.UTF8Encoding]::new($false))
Write-Ok "Original distribution config saved to $backupEnvelope"

$currentWebAcl = ''
if ($config.PSObject.Properties.Name -contains 'WebACLId') { $currentWebAcl = [string]$config.WebACLId }

if ($currentWebAcl -eq $WebAclArn) {
    Write-Ok "Distribution is ALREADY attached to WebACL '$WebAclName'. No CloudFront change needed."
    $skipUpdate = $true
} else {
    $skipUpdate = $false
    if ($currentWebAcl) {
        Write-Warn "Distribution currently points at a DIFFERENT WebACL: $currentWebAcl"
        Write-Warn 'It will be replaced with the WebACL created/selected by this script.'
    }
    # Set (or add) WebACLId on the distribution config.
    if ($config.PSObject.Properties.Name -contains 'WebACLId') {
        $config.WebACLId = $WebAclArn
    } else {
        $config | Add-Member -NotePropertyName 'WebACLId' -NotePropertyValue $WebAclArn -Force
    }
    Write-Step "Set DistributionConfig.WebACLId -> $WebAclArn"

    # -Depth 100 is essential: CloudFront configs are deeply nested and a shallow
    # ConvertTo-Json silently truncates nested arrays into "System.Object[]".
    $updatedConfigFile = Join-Path $ArtifactDir "waf-$DistributionId-UPDATED-$Stamp.json"
    Write-JsonFile -Path $updatedConfigFile -Object $config
    Write-Step "Wrote updated distribution config to $updatedConfigFile"

    Confirm-Step "Attach WebACL '$WebAclName' to distribution '$DistributionId' now?"

    $updateResult = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "update-distribution $DistributionId" `
        cloudfront update-distribution `
        --id $DistributionId `
        --distribution-config "file://$updatedConfigFile" `
        --if-match $ETag `
        --output json

    if (-not $DryRun) {
        $updated = $updateResult | ConvertFrom-Json
        $newWebAcl = [string]$updated.Distribution.DistributionConfig.WebACLId
        Write-Ok "Distribution updated. New ETag: $($updated.ETag)"
        Write-Diag "WebACLId now: $newWebAcl"
        if ($newWebAcl -ne $WebAclArn) {
            throw "Post-update verification failed: WebACLId is '$newWebAcl' (expected '$WebAclArn')."
        }
    } else {
        Write-Ok "[DRY-RUN] would update-distribution to attach the WebACL with --if-match $ETag."
    }
}

# ==============================================================================
# PHASE 4 - Wait for deploy, then verify WAF is active and logging
# ==============================================================================
Write-Phase 'PHASE 4: Wait for deploy + verify WAF is active and logging'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: read-only checks + rule/config rewrites validated.'
    Write-Warn 'No WebACL, logging, or distribution changes were made.'
    Write-Host ''
    Write-Step "WAF console (after a real run):"
    Write-Diag "https://us-east-1.console.aws.amazon.com/wafv2/homev2/web-acl/$WebAclName/$WebAclId/overview?region=global"
    Write-Host ''
    return
}

if (-not $skipUpdate) {
    Write-Step 'Waiting for Status=Deployed (CloudFront propagation usually takes a few minutes)...'
    Invoke-Aws -Retries 2 -DelaySeconds 10 -What "wait distribution-deployed $DistributionId" `
        cloudfront wait distribution-deployed --id $DistributionId
    Write-Ok 'Distribution finished deploying (Status=Deployed).'
}

Write-Step 'Verifying the WebACL exists and reports its rules...'
$verifyJson = Invoke-Aws -Retries 3 -DelaySeconds 5 `
    wafv2 get-web-acl --name $WebAclName --scope $WebAclScope --id $WebAclId --output json
$verify = $verifyJson | ConvertFrom-Json
$ruleNames = @($verify.WebACL.Rules | ForEach-Object { $_.Name })
Write-Diag "WebACL rules: $($ruleNames -join ', ')"
Write-Ok 'WebACL is active.'

if (-not $NoLogging) {
    Write-Step 'Verifying WAF logging configuration...'
    try {
        $logCfgJson = Invoke-Aws -Retries 2 -DelaySeconds 5 `
            wafv2 get-logging-configuration --resource-arn $WebAclArn --output json
        $logCfg = $logCfgJson | ConvertFrom-Json
        $dests = @($logCfg.LoggingConfiguration.LogDestinationConfigs)
        Write-Diag "log destinations: $($dests -join ', ')"
        Write-Ok 'WAF logging is configured.'
    } catch {
        Write-Warn "Could not read logging configuration (it may still be propagating): $($_.Exception.Message)"
    }
}

Write-Step "Probing $CloudFrontUrl to confirm legitimate traffic still passes..."
try {
    $resp = Invoke-WebRequest -Uri $CloudFrontUrl -UseBasicParsing -TimeoutSec 30
    Write-Diag "HTTP $($resp.StatusCode)"
    if ($resp.StatusCode -eq 200) { Write-Ok 'Endpoint returned 200 (WAF is not blocking normal traffic).' }
    else { Write-Warn "Endpoint returned $($resp.StatusCode); verify this is expected." }
} catch {
    Write-Warn "Endpoint probe failed: $($_.Exception.Message)"
}

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: WAF WebACL is created/attached to the CloudFront distribution' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  distribution : $DistributionId" -ForegroundColor Green
Write-Host "  web acl      : $WebAclName ($WebAclId)" -ForegroundColor Green
Write-Host "  web acl arn  : $WebAclArn" -ForegroundColor Green
Write-Host "  rate limit   : $RateLimit requests / 5 min per IP" -ForegroundColor Green
Write-Host "  logging      : $(if ($NoLogging) { 'disabled (-NoLogging)' } else { $LogGroupName })" -ForegroundColor Green
Write-Host ''
Write-Host '  WAF console:' -ForegroundColor Yellow
Write-Host "    https://us-east-1.console.aws.amazon.com/wafv2/homev2/web-acl/$WebAclName/$WebAclId/overview?region=global" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Artifacts (audit / rollback):' -ForegroundColor Yellow
Write-Host "    rules    : $rulesFile" -ForegroundColor DarkGray
Write-Host "    original : $backupEnvelope" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  To DETACH the WebACL: set DistributionConfig.WebACLId = "" and' -ForegroundColor Yellow
Write-Host '  update-distribution with the saved ORIGINAL config + its ETag.' -ForegroundColor DarkGray
Write-Host ''
Write-Ok 'CloudFront WAF enablement complete.'
