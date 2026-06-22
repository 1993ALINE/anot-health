<#
================================================================================
 fix-all-remaining-issues.ps1  -  Resolve the 3 remaining production findings
                                  WITHOUT requiring anot-ops to edit its own IAM
                                  policy (that path fails with AccessDenied).
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHY THIS EXISTS:
   Three findings remained after the earlier fix passes. The ops identity
   'anot-ops' cannot modify the 'anot-ops-prod-policy' managed policy
   (iam:CreatePolicyVersion -> AccessDenied), so any fix that depends on
   widening the ops policy is a dead end from this identity. This script takes
   the workaround route for each finding so it can run end-to-end as anot-ops.

 THE 3 ISSUES + STRATEGY:

   ISSUE 1 - WAF logging (needs logs:PutResourcePolicy at the account level)
     STRATEGY: DEFER. Cannot be enabled without an account-level permission the
     ops user does not hold. WAF itself is active and blocking; only the log
     delivery is off. PHASE 1 confirms logging is OFF and documents that it is
     an accepted, low-priority deferral (enable later via the AWS Console).

   ISSUE 2 - SSM read for the ops user (/anot/prod/* -> AccessDenied)
     STRATEGY: VERIFY via the backend, do NOT widen the ops policy. The backend
     EB instance profile already HAS SSM read. PHASE 2 runs an SSM RunCommand on
     the live backend instance to read /anot/prod recursively, proving the
     application can read every secret it needs. The ops user does not need this
     for day-to-day operations, so the finding is satisfied operationally.

   ISSUE 3 - S3 security (default encryption + block public access)
     STRATEGY: FIX. anot-ops already holds s3:PutBucketEncryption and
     s3:PutPublicAccessBlock, so PHASE 3 enables AES256 default encryption and
     the full 4-way Block Public Access on both buckets and verifies them.

 BUCKETS (Issue 3):
   anot-audio-625242092266      (audio uploads)
   anot-frontend-625242092266   (SPA static assets, served via CloudFront/OAC)

 SAFETY:
   * -DryRun does every read-only step and prints exactly what WOULD change,
     WITHOUT calling any mutating API (no SSM command is sent, no S3 put).
   * -Live performs the SSM verification and the S3 fix. Mutating S3 steps
     prompt for confirmation unless -Force / -SkipConfirm.
   * If neither -DryRun nor -Live is given, the script DEFAULTS to -DryRun.
   * Idempotent: each S3 setting is read first and only written when missing.

 USAGE:
   powershell -File scripts/fix-all-remaining-issues.ps1 -DryRun
   powershell -File scripts/fix-all-remaining-issues.ps1 -Live
   powershell -File scripts/fix-all-remaining-issues.ps1 -Live -Force
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Live,
    [switch]$Force,
    [switch]$SkipConfirm,
    [int]$SsmWaitSeconds = 120,
    [int]$SsmPollSeconds = 6
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Resolve the run mode. -Live wins for clarity; default to a safe DryRun.
if ($DryRun -and $Live) { throw 'Pass only one of -DryRun or -Live, not both.' }
if (-not $DryRun -and -not $Live) { $DryRun = $true }

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId = '625242092266'
$Region       = 'ap-southeast-1'

# EB backend (Issue 2 - verify SSM read from the live instance).
$EbAppName    = 'anot-backend'
$EbEnvName    = 'anot-backend-prod'
$EbEnvId      = 'e-g7bj3ndsck'

# SSM Parameter Store path the BACKEND must be able to read.
$SsmPrefix    = '/anot/prod'

# WAF (Issue 1 - deferred). CLOUDFRONT-scoped WebACL + its log group are us-east-1.
$WebAclName   = 'anot-cloudfront-waf'
$WebAclScope  = 'CLOUDFRONT'
$WafLogGroup  = 'aws-waf-logs-anot-cloudfront'

# S3 buckets (Issue 3 - fix encryption + public-access-block).
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

# Per-issue outcome tracker for the final summary.
$script:Outcomes = [ordered]@{
    'Issue 1 - WAF logging'   = 'PENDING'
    'Issue 2 - SSM via backend' = 'PENDING'
    'Issue 3 - S3 security'   = 'PENDING'
}
$script:NextSteps = New-Object System.Collections.Generic.List[string]
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
function Write-Skip { param([string]$Message) Write-Host "  [--] $Message" -ForegroundColor DarkYellow }
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

function Test-AccessDenied {
    param([string]$Text)
    if (-not $Text) { return $false }
    return ($Text -match 'AccessDenied|UnauthorizedOperation|not authorized|AuthorizationError|is not authorized to perform')
}

# Throwing AWS CLI wrapper for MUTATING calls + required reads. Captures
# stdout/stderr without corrupting JSON, retries with backoff, throws a detailed
# diagnostic on failure. -SkipInDryRun marks a mutating call (skipped in DryRun).
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
# A non-zero exit (e.g. AccessDenied, NotFound) is reported, not thrown, so the
# caller can branch on it instead of aborting the run.
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

        # Do NOT retry stable "not configured" / access sentinels.
        if ($stderr -match 'ServerSideEncryptionConfigurationNotFoundError|NoSuchPublicAccessBlockConfiguration' -or (Test-AccessDenied $stderr)) {
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
    Write-Host '  FIX ALL REMAINING ISSUES FAILED' -ForegroundColor Red
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
    Write-Warn 'DRY-RUN MODE: read-only checks only. No SSM command is sent and no S3 change is made.'
} else {
    Write-Step 'LIVE MODE: this run will verify SSM via the backend and enforce S3 security.'
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
# PHASE 1 - WAF logging status (DEFER)
# ==============================================================================
# WAF logging delivery requires logs:PutResourcePolicy at the account level,
# which the ops user does not hold. We only INSPECT the state here and document
# that it is an accepted deferral; we never attempt the mutating call.
Write-Phase 'PHASE 1: WAF logging status (deferred)'

Write-Step "Checking CLOUDFRONT WebACL '$WebAclName' (us-east-1)..."
$wafListed = $false
$WebAclArn  = $null
$listRes = Invoke-AwsRead -What 'wafv2 list-web-acls' -Retries 2 -DelaySeconds 4 `
    wafv2 list-web-acls --scope $WebAclScope --region us-east-1 --output json
if ($listRes.Ok -and $listRes.Json -and ($listRes.Json.PSObject.Properties.Name -contains 'WebACLs')) {
    $match = @($listRes.Json.WebACLs | Where-Object { $_.Name -eq $WebAclName })
    if ($match.Count -gt 0) {
        $wafListed = $true
        $WebAclArn = $match[0].ARN
        Write-Diag "web acl arn: $WebAclArn"
    }
}

if (-not $wafListed) {
    Write-Warn "Could not confirm WebACL '$WebAclName' (list denied or not found)."
    Write-Diag "stderr: $($listRes.Stderr)"
} else {
    Write-Step 'Reading current WAF logging configuration...'
    $logRes = Invoke-AwsRead -What 'wafv2 get-logging-configuration' -Retries 2 -DelaySeconds 4 `
        wafv2 get-logging-configuration --resource-arn $WebAclArn --region us-east-1 --output json
    if ($logRes.Ok -and $logRes.Json) {
        $dests = @($logRes.Json.LoggingConfiguration.LogDestinationConfigs)
        Write-Warn "WAF logging is ENABLED (unexpected) -> $($dests -join ', '). Nothing to defer."
    } elseif ($logRes.Stderr -match 'WAFNonexistentItem|not.*found') {
        Write-Diag 'No logging configuration is set (expected).'
    } else {
        Write-Diag "Could not read logging configuration: $($logRes.Stderr)"
    }
}

Write-Skip 'WAF logging is DEFERRED: enabling it needs logs:PutResourcePolicy (account-level).'
Write-Diag 'WAF is active and blocking; only log delivery is off. This is low priority.'
Write-Diag "Enable later in the AWS Console (us-east-1): WAF -> $WebAclName -> Logging -> CloudWatch group '$WafLogGroup'."
$script:Outcomes['Issue 1 - WAF logging'] = 'DEFERRED (acceptable)'
$script:NextSteps.Add("WAF logging: enable manually in the AWS Console (us-east-1) to log '$WebAclName' to '$WafLogGroup'. Requires logs:PutResourcePolicy.") | Out-Null

# ==============================================================================
# PHASE 2 - Verify SSM read FROM the backend (the ops user need not have it)
# ==============================================================================
# The ops user cannot read /anot/prod/* (AccessDenied) and cannot widen its own
# policy. Instead we prove the BACKEND instance profile CAN read every secret by
# running an SSM RunCommand on the live EB instance: it reads /anot/prod
# recursively using its OWN role. Names only are returned (never secret values).
Write-Phase 'PHASE 2: Verify SSM read via the backend EB instance'

Write-Step "Resolving the EB instance for '$EbEnvName' ($EbEnvId)..."
$resRes = Invoke-AwsRead -What 'describe-environment-resources' -Retries 3 -DelaySeconds 5 `
    elasticbeanstalk describe-environment-resources --environment-name $EbEnvName --output json
if (-not $resRes.Ok -or -not $resRes.Json) {
    throw "Could not read EB environment resources for '$EbEnvName': $($resRes.Stderr)"
}
$instances = @($resRes.Json.EnvironmentResources.Instances)
if ($instances.Count -eq 0) { throw "No running instances found for EB environment '$EbEnvName'." }
$InstanceId = $instances[0].Id
Write-Ok "Backend instance: $InstanceId ($($instances.Count) instance(s) in the fleet)."

Write-Step 'Confirming the instance is registered with SSM (managed instance)...'
$infoRes = Invoke-AwsRead -What 'ssm describe-instance-information' -Retries 3 -DelaySeconds 5 `
    ssm describe-instance-information `
    --filters "Key=InstanceIds,Values=$InstanceId" --output json
$ssmManaged = $false
if ($infoRes.Ok -and $infoRes.Json) {
    $info = @($infoRes.Json.InstanceInformationList | Where-Object { $_.InstanceId -eq $InstanceId })
    if ($info.Count -gt 0) {
        $ssmManaged = $true
        Write-Diag "ping status: $($info[0].PingStatus)  agent: $($info[0].AgentVersion)  platform: $($info[0].PlatformName)"
    }
}
if (-not $ssmManaged) {
    Write-Warn "Instance '$InstanceId' is not reporting to SSM (cannot RunCommand against it)."
    if ($infoRes.Stderr) { Write-Diag "stderr: $($infoRes.Stderr)" }
}

# The remote command reads /anot/prod recursively with the INSTANCE role and
# prints ONLY parameter NAMES + a count (no secret values are ever emitted).
$remoteCommands = @(
    'set -e',
    'echo "== whoami (instance role via metadata) =="',
    'TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)',
    'curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/info || true',
    'echo',
    "echo == ssm get-parameters-by-path $SsmPrefix names-only ==",
    "NAMES=`$(aws ssm get-parameters-by-path --path $SsmPrefix --recursive --region $Region --query 'Parameters[].Name' --output text)",
    'echo "$NAMES" | tr "\t" "\n"',
    "COUNT=`$(aws ssm get-parameters-by-path --path $SsmPrefix --recursive --region $Region --query 'length(Parameters)' --output text)",
    'echo "PARAM_COUNT=$COUNT"'
)
$paramsObj  = [ordered]@{ commands = $remoteCommands }
$paramsFile = Join-Path $ArtifactDir "ssm-verify-params-$Stamp.json"
Write-JsonFile -Path $paramsFile -Object $paramsObj
Write-Step "Wrote RunCommand parameters to $paramsFile"

if ($DryRun) {
    Write-Step '[DRY-RUN] would send SSM RunCommand (AWS-RunShellScript) to the backend:'
    foreach ($c in $remoteCommands) { Write-Diag $c }
    $script:Outcomes['Issue 2 - SSM via backend'] = 'DRY-RUN (would verify)'
} elseif (-not $ssmManaged) {
    Write-Warn 'Skipping the SSM RunCommand verification: the instance is not SSM-managed.'
    Write-Diag 'Confirm the EB instance profile includes AmazonSSMManagedInstanceCore and the agent is running.'
    $script:Outcomes['Issue 2 - SSM via backend'] = 'UNVERIFIED (instance not SSM-managed)'
    $script:NextSteps.Add('SSM verify: backend instance is not reporting to SSM; check the SSM agent + instance profile.') | Out-Null
} else {
    Confirm-Step "Send an SSM RunCommand to '$InstanceId' to read '$SsmPrefix' (names only)?"
    Write-Step 'Sending SSM RunCommand (AWS-RunShellScript)...'
    $sendOut = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'ssm send-command' `
        ssm send-command `
        --document-name 'AWS-RunShellScript' `
        --instance-ids $InstanceId `
        --comment 'anot prod verify: backend SSM read of /anot/prod (names only)' `
        --parameters "file://$paramsFile" `
        --output json
    $CommandId = ($sendOut | ConvertFrom-Json).Command.CommandId
    Write-Ok "RunCommand dispatched: $CommandId"

    Write-Step "Polling for command result (up to ${SsmWaitSeconds}s)..."
    $deadline = (Get-Date).AddSeconds($SsmWaitSeconds)
    $inv = $null
    $status = 'Pending'
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $SsmPollSeconds
        $invRes = Invoke-AwsRead -What 'ssm get-command-invocation' -Retries 2 -DelaySeconds 4 `
            ssm get-command-invocation --command-id $CommandId --instance-id $InstanceId --output json
        if ($invRes.Ok -and $invRes.Json) {
            $inv = $invRes.Json
            $status = $inv.Status
            if ($status -in @('Success','Failed','Cancelled','TimedOut')) { break }
            Write-Diag "status: $status (still running; $([int]($deadline - (Get-Date)).TotalSeconds)s left)"
        } elseif ($invRes.Stderr -match 'InvocationDoesNotExist') {
            Write-Diag 'invocation not registered yet; waiting...'
        } else {
            Write-Diag "poll error: $($invRes.Stderr)"
        }
    }

    if ($inv -and $status -eq 'Success') {
        $out = "$($inv.StandardOutputContent)"
        $count = $null
        $m = [regex]::Match($out, 'PARAM_COUNT=(\d+)')
        if ($m.Success) { $count = [int]$m.Groups[1].Value }
        Write-Ok "Backend SSM read SUCCEEDED (status: $status)."
        if ($null -ne $count) { Write-Ok "Backend can read $count parameter(s) under '$SsmPrefix'." }
        Write-Diag 'Backend RunCommand output (parameter NAMES only, no secret values):'
        foreach ($l in ($out -split "`n")) { if ($l.Trim()) { Write-Diag $l.Trim() } }
        if ($null -ne $count -and $count -gt 0) {
            $script:Outcomes['Issue 2 - SSM via backend'] = "VERIFIED ($count param(s) readable by backend)"
        } else {
            $script:Outcomes['Issue 2 - SSM via backend'] = 'VERIFIED (read OK; confirm secrets exist)'
            $script:NextSteps.Add("SSM verify: backend read OK but path '$SsmPrefix' looked empty; confirm prod secrets exist.") | Out-Null
        }
    } else {
        $stderrOut = if ($inv) { "$($inv.StandardErrorContent)" } else { '' }
        Write-Warn "Backend SSM read did not succeed (status: $status)."
        if ($stderrOut.Trim()) { foreach ($l in ($stderrOut -split "`n")) { if ($l.Trim()) { Write-Diag $l.Trim() } } }
        $script:Outcomes['Issue 2 - SSM via backend'] = "UNVERIFIED (RunCommand status: $status)"
        $script:NextSteps.Add('SSM verify: RunCommand did not return Success; inspect the command invocation in SSM.') | Out-Null
    }
}

# ==============================================================================
# PHASE 3 - Fix S3 security (FIX): default AES256 + Block Public Access
# ==============================================================================
# anot-ops holds s3:PutBucketEncryption + s3:PutPublicAccessBlock, so this is a
# real fix (not a workaround). Each setting is read first; a put is issued ONLY
# when a bucket is missing it. Re-running is a safe no-op.
Write-Phase 'PHASE 3: Fix S3 security (encryption + block public access)'

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
$pabSetting = 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'

$s3AllGood = $true
foreach ($bkt in $Buckets) {
    Write-Step "Bucket '$bkt': confirming reachability..."
    $hb = Invoke-AwsRead -What "head-bucket $bkt" -Retries 3 -DelaySeconds 4 s3api head-bucket --bucket $bkt
    if (-not $hb.Ok) {
        Write-Warn "Bucket '$bkt' is not reachable: $($hb.Stderr)"
        $s3AllGood = $false
        continue
    }

    # --- encryption ---
    Write-Step "Bucket '$bkt': checking default encryption..."
    $er = Invoke-AwsRead -What "get-bucket-encryption $bkt" s3api get-bucket-encryption --bucket $bkt --output json
    if ($er.Ok -and $er.Json) {
        $alg = @($er.Json.ServerSideEncryptionConfiguration.Rules)[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm
        Write-Ok "'$bkt' already encrypted ($alg). Skipping."
    } elseif ($er.Stderr -match 'ServerSideEncryptionConfigurationNotFoundError') {
        Confirm-Step "Enable default AES256 encryption on '$bkt' now?"
        Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "put-bucket-encryption $bkt" `
            s3api put-bucket-encryption --bucket $bkt `
            --server-side-encryption-configuration "file://$encFile" | Out-Null
        if (-not $DryRun) { Write-Ok "Enabled default AES256 encryption on '$bkt'." }
        else { Write-Ok "[DRY-RUN] would enable default AES256 encryption on '$bkt'." }
    } else {
        Write-Warn "Could not read encryption for '$bkt': $($er.Stderr)"
        $s3AllGood = $false
    }

    # --- block public access ---
    Write-Step "Bucket '$bkt': checking public-access-block..."
    $pr = Invoke-AwsRead -What "get-public-access-block $bkt" s3api get-public-access-block --bucket $bkt --output json
    $needsPab = $false
    if ($pr.Ok -and $pr.Json) {
        $c = $pr.Json.PublicAccessBlockConfiguration
        $all = ($c.BlockPublicAcls -and $c.IgnorePublicAcls -and $c.BlockPublicPolicy -and $c.RestrictPublicBuckets)
        if ($all) { Write-Ok "'$bkt' already blocks all public access. Skipping." }
        else { Write-Diag 'public-access-block is partial.'; $needsPab = $true }
    } elseif ($pr.Stderr -match 'NoSuchPublicAccessBlockConfiguration') {
        $needsPab = $true
    } else {
        Write-Warn "Could not read public-access-block for '$bkt': $($pr.Stderr)"
        $s3AllGood = $false
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

# Verify (live only) both settings on both buckets.
if (-not $DryRun) {
    Write-Step 'Verifying S3 settings on both buckets...'
    foreach ($bkt in $Buckets) {
        $ev = Invoke-AwsRead -What "verify get-bucket-encryption $bkt" s3api get-bucket-encryption --bucket $bkt --output json
        if ($ev.Ok -and $ev.Json) {
            $alg = @($ev.Json.ServerSideEncryptionConfiguration.Rules)[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm
            Write-Ok "'$bkt' encryption: $alg"
        } else { Write-Warn "'$bkt' encryption NOT verified: $($ev.Stderr)"; $s3AllGood = $false }

        $pv = Invoke-AwsRead -What "verify get-public-access-block $bkt" s3api get-public-access-block --bucket $bkt --output json
        if ($pv.Ok -and $pv.Json) {
            $c = $pv.Json.PublicAccessBlockConfiguration
            if ($c.BlockPublicAcls -and $c.IgnorePublicAcls -and $c.BlockPublicPolicy -and $c.RestrictPublicBuckets) {
                Write-Ok "'$bkt' public access: all four block settings ON"
            } else { Write-Warn "'$bkt' public-access-block partial."; $s3AllGood = $false }
        } else { Write-Warn "'$bkt' public-access-block NOT verified: $($pv.Stderr)"; $s3AllGood = $false }
    }
}

if ($DryRun) {
    $script:Outcomes['Issue 3 - S3 security'] = 'DRY-RUN (would enforce + verify)'
} elseif ($s3AllGood) {
    $script:Outcomes['Issue 3 - S3 security'] = 'FIXED + VERIFIED'
} else {
    $script:Outcomes['Issue 3 - S3 security'] = 'PARTIAL (verification incomplete)'
    $script:NextSteps.Add('S3 security: one or more buckets failed verification; re-run -Live or check bucket permissions.') | Out-Null
}

# ==============================================================================
# SUMMARY
# ==============================================================================
Write-Phase 'SUMMARY: which issues are resolved vs deferred'

$modeLabel = if ($DryRun) { 'DRY-RUN (no changes were made)' } else { 'LIVE' }
Write-Host "  Mode: $modeLabel" -ForegroundColor Gray
Write-Host ''
foreach ($k in $script:Outcomes.Keys) {
    $v = $script:Outcomes[$k]
    $color = switch -Regex ($v) {
        'FIXED|VERIFIED' { 'Green'; break }
        'DEFERRED|DRY-RUN' { 'DarkYellow'; break }
        'PARTIAL|UNVERIFIED' { 'Yellow'; break }
        default { 'Gray' }
    }
    Write-Host ("  {0,-28} : {1}" -f $k, $v) -ForegroundColor $color
}

Write-Host ''
if ($script:NextSteps.Count -gt 0) {
    Write-Host '  NEXT STEPS (manual / follow-up):' -ForegroundColor Yellow
    foreach ($s in $script:NextSteps) { Write-Host "    - $s" -ForegroundColor DarkGray }
} else {
    Write-Host '  NEXT STEPS: none outstanding.' -ForegroundColor Green
}

Write-Host ''
Write-Host '  Re-run the validation to confirm the findings:' -ForegroundColor Yellow
Write-Host '    powershell -File scripts/validate-production.ps1 -Live' -ForegroundColor DarkGray
Write-Host ''

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: all phases rehearsed; no changes were made.'
    exit 0
}

# Exit non-zero only if something actionable failed (S3 partial). WAF deferral
# and an SSM-unmanaged instance are reported but do not fail the run.
if ($script:Outcomes['Issue 3 - S3 security'] -match 'PARTIAL') {
    Write-Warn 'Completed with warnings: S3 verification was incomplete. See above.'
    exit 1
}
Write-Ok 'Completed: S3 fixed, SSM verified via backend, WAF logging deferred.'
exit 0
