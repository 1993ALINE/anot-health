<#
================================================================================
 update-ops-policy-oac.ps1  -  Add CloudFront OAC + S3 bucket-lockdown
                               permissions to the 'anot-ops-prod-policy'
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHY THIS EXISTS:
   enable-cloudfront-oac.ps1 fails for the ops user with AccessDenied on
   'cloudfront:ListOriginAccessControls' (and would also miss CreateOAC and the
   S3 bucket-policy / public-access-block actions). This script grants exactly
   the missing permissions, idempotently.

 WHAT THIS DOES:
   Reads the CURRENT DEFAULT version of the customer-managed policy
   'anot-ops-prod-policy', merges in two statements (idempotently, keyed by Sid),
   then publishes the merged document as a NEW DEFAULT policy version via
   'iam create-policy-version --set-as-default'.

 THE STATEMENTS ADDED (Sids):
   CloudFrontOacManage   cloudfront:ListOriginAccessControls /
                         CreateOriginAccessControl / GetOriginAccessControl
                         (Resource *: these OAC actions do NOT support
                          resource-level permissions, same as cloudfront:List*)
   S3FrontendBucketAdmin s3:GetBucketPolicy / PutBucketPolicy /
                         GetBucketPublicAccessBlock / PutBucketPublicAccessBlock
                         (scoped to the frontend bucket ARN)

 ALREADY PRESENT (in create-iam-ops-user.ps1, so NOT re-added here):
   cloudfront:GetDistribution / GetDistributionConfig / UpdateDistribution
   (Sid CloudFrontManageProdDistribution) and s3:ListBucket / object RW. The OAC
   script reuses those; only the actions above were missing.

 VERSION LIMIT: a managed policy keeps at most 5 versions. If 5 already exist we
   delete the OLDEST NON-DEFAULT version before publishing, so the call never
   fails with LimitExceeded. The source-of-truth document also lives in
   create-iam-ops-user.ps1 (PHASE 2); this script is the targeted in-place patch.

 SAFETY:
   * Idempotent: if the two Sids are already present and unchanged, no new
     version is published.
   * -DryRun does every read-only step and writes the proposed merged document
     to disk for inspection, WITHOUT deleting versions or calling
     create-policy-version.
   * Mutating steps prompt for confirmation unless -Force / -SkipConfirm.

 USAGE:
   powershell -File scripts/update-ops-policy-oac.ps1 -DryRun   # rehearse
   powershell -File scripts/update-ops-policy-oac.ps1           # apply (prompts)
   powershell -File scripts/update-ops-policy-oac.ps1 -Force    # apply, no prompts
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun,
    [string]$ManagedPolicyName = 'anot-ops-prod-policy'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId   = '625242092266'
$Region         = 'ap-southeast-1'
$ManagedPolicyArn = "arn:aws:iam::${AwsAccountId}:policy/${ManagedPolicyName}"

# The frontend bucket the OAC script locks down. Bucket-level S3 actions
# (GetBucketPolicy / PutBucketPolicy / *PublicAccessBlock) target the bucket ARN.
$FrontendBucket = "anot-frontend-$AwsAccountId"
$FrontBktArn    = "arn:aws:s3:::$FrontendBucket"

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'

# IAM is a GLOBAL service; calls work from any region. Pin one anyway + kill pager.
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
#endregion

# ------------------------------------------------------------------------------
# Failure trap: name the phase, show the underlying error, exit non-zero.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  UPDATE OPS POLICY (OAC) FAILED' -ForegroundColor Red
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
Write-Phase 'PRE-FLIGHT: tooling + identity + policy checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No policy version will be created or deleted.'
} else {
    Write-Step 'LIVE MODE: this run will publish a NEW DEFAULT version of the managed policy.'
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

Write-Step "Confirming managed policy '$ManagedPolicyName' exists..."
$policyMeta = Invoke-Aws -Retries 3 -DelaySeconds 5 -What "iam get-policy $ManagedPolicyName" `
    iam get-policy --policy-arn $ManagedPolicyArn --output json | ConvertFrom-Json
$defaultVersionId = $policyMeta.Policy.DefaultVersionId
Write-Diag "policy arn      : $ManagedPolicyArn"
Write-Diag "default version : $defaultVersionId"
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Read the current default policy document
# ==============================================================================
Write-Phase 'PHASE 1: Read the current default policy version'

# The AWS CLI URL-decodes PolicyVersion.Document into a real JSON object for us.
$versionRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'iam get-policy-version' `
    iam get-policy-version --policy-arn $ManagedPolicyArn --version-id $defaultVersionId --output json
$policyDoc = ($versionRaw | ConvertFrom-Json).PolicyVersion.Document
if ($null -eq $policyDoc) { throw 'Could not read the current policy document.' }

$existingStatements = @($policyDoc.Statement)
$existingSids = @($existingStatements | ForEach-Object { if ($_.PSObject.Properties.Name -contains 'Sid') { $_.Sid } })
Write-Step "Current policy has $($existingStatements.Count) statement(s)."
Write-Diag "Sids: $((@($existingSids | Where-Object { $_ })) -join ', ')"

# ==============================================================================
# PHASE 2 - Merge in the OAC + S3 bucket-admin statements (idempotent, by Sid)
# ==============================================================================
Write-Phase 'PHASE 2: Merge OAC + S3 bucket-admin statements'

$oacStatements = @(
    [ordered]@{
        Sid      = 'CloudFrontOacManage'
        Effect   = 'Allow'
        Action   = @(
            'cloudfront:ListOriginAccessControls',
            'cloudfront:CreateOriginAccessControl',
            'cloudfront:GetOriginAccessControl'
        )
        # These OAC actions do NOT support resource-level permissions; Resource
        # must be '*' (mirrors the existing cloudfront:List* statement).
        Resource = '*'
    },
    [ordered]@{
        Sid      = 'S3FrontendBucketAdmin'
        Effect   = 'Allow'
        Action   = @(
            's3:GetBucketPolicy',
            's3:PutBucketPolicy',
            's3:GetBucketPublicAccessBlock',
            's3:PutBucketPublicAccessBlock'
        )
        # Bucket-level actions target the BUCKET ARN (no trailing /*).
        Resource = $FrontBktArn
    }
)
$oacSids = @($oacStatements | ForEach-Object { $_.Sid })

# Idempotent merge: drop any existing statements that share our Sids, then append
# the fresh definitions. Re-running thus REFRESHES our statements in place and
# never duplicates them. (Statements without a Sid, or with other Sids, are kept.)
$keptStatements = @($existingStatements | Where-Object {
    -not (($_.PSObject.Properties.Name -contains 'Sid') -and ($oacSids -contains $_.Sid))
})
$mergedStatements = @($keptStatements) + @($oacStatements)

$alreadyPresent = @($oacSids | Where-Object { $existingSids -contains $_ })
if ($alreadyPresent.Count -gt 0) {
    Write-Step "Existing OAC statements found and will be refreshed: $($alreadyPresent -join ', ')"
} else {
    Write-Step "Adding new OAC statements: $($oacSids -join ', ')"
}

$mergedPolicy = [ordered]@{
    Version   = $policyDoc.Version
    Statement = $mergedStatements
}

# IAM strips whitespace when measuring size; ascii encoding writes NO BOM (the
# AWS CLI file:// parser rejects a UTF-8 BOM). Matches update-ops-policy-wafv2.ps1.
$mergedFile = Join-Path $ArtifactDir "anot-ops-policy-oac-$Stamp.json"
$mergedJson = $mergedPolicy | ConvertTo-Json -Depth 20
$mergedJson | Out-File -FilePath $mergedFile -Encoding ascii
$compactLen = ($mergedJson -replace '\s', '').Length
Write-Step "Wrote merged policy document to $mergedFile"
Write-Diag "merged statements   : $($mergedStatements.Count)"
Write-Diag "compact policy size : $compactLen chars (customer-managed limit = 6144)"
if ($compactLen -gt 6144) {
    throw "Merged policy is $compactLen chars, over the 6144 customer-managed limit. Trim actions/statements."
}

# Decide whether anything actually changed (avoid publishing a no-op version).
# Compare a normalized (compact, sorted-key) form of old vs new statement sets.
function ConvertTo-Normalized {
    param($Obj)
    ($Obj | ConvertTo-Json -Depth 20 -Compress)
}
$oldNorm = ConvertTo-Normalized (@($existingStatements) | Sort-Object { ConvertTo-Normalized $_ })
$newNorm = ConvertTo-Normalized (@($mergedStatements)  | Sort-Object { ConvertTo-Normalized $_ })
$noChange = ($oldNorm -eq $newNorm)

if ($noChange) {
    Write-Ok 'Policy already contains these OAC + S3 bucket-admin permissions (unchanged). Nothing to publish.'
    Write-Host ''
    return
}

# ==============================================================================
# PHASE 3 - Publish as a new default version (prune oldest if at the 5 limit)
# ==============================================================================
Write-Phase 'PHASE 3: Publish new default policy version'

# A managed policy keeps at most 5 versions. Prune the oldest NON-default version
# first so create-policy-version never fails with LimitExceeded.
if (-not $DryRun) {
    $verRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'iam list-policy-versions' `
        iam list-policy-versions --policy-arn $ManagedPolicyArn --output json
    $versions = @(($verRaw | ConvertFrom-Json).Versions)
    Write-Diag "existing versions: $((@($versions | ForEach-Object { $_.VersionId })) -join ', ') (count=$($versions.Count))"
    if ($versions.Count -ge 5) {
        $oldest = @($versions | Where-Object { -not $_.IsDefaultVersion } |
            Sort-Object { [datetime]$_.CreateDate })[0]
        if ($oldest) {
            Write-Step "5 versions present; deleting oldest non-default version $($oldest.VersionId)."
            Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'iam delete-policy-version' `
                iam delete-policy-version --policy-arn $ManagedPolicyArn --version-id $oldest.VersionId | Out-Null
        } else {
            Write-Warn 'At the 5-version limit but found no non-default version to delete; create may fail.'
        }
    }
}

Confirm-Step "Publish a NEW DEFAULT version of '$ManagedPolicyName' with the OAC permissions?"

$createOut = Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'iam create-policy-version' `
    iam create-policy-version --policy-arn $ManagedPolicyArn `
    --policy-document "file://$mergedFile" --set-as-default --output json

if ($DryRun) {
    Write-Ok '[DRY-RUN] would publish the merged document above as the new default version.'
    Write-Host ''
    Write-Step 'Proposed document saved for inspection at:'
    Write-Diag $mergedFile
    Write-Host ''
    return
}

$newVersionId = ($createOut | ConvertFrom-Json).PolicyVersion.VersionId
Write-Ok "Published new default policy version: $newVersionId"

# ==============================================================================
# PHASE 4 - Verify the new default version contains the OAC actions
# ==============================================================================
Write-Phase 'PHASE 4: Verify the new default version'

$verifyRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'iam get-policy-version (verify)' `
    iam get-policy-version --policy-arn $ManagedPolicyArn --version-id $newVersionId --output json
$verifyDoc = ($verifyRaw | ConvertFrom-Json).PolicyVersion.Document
$verifySids = @($verifyDoc.Statement | ForEach-Object { if ($_.PSObject.Properties.Name -contains 'Sid') { $_.Sid } })
$missing = @($oacSids | Where-Object { $verifySids -notcontains $_ })
if ($missing.Count -gt 0) {
    throw "Verification failed: new default version is missing statement(s): $($missing -join ', ')."
}
Write-Ok "New default version contains: $($oacSids -join ', ')"

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: OAC + S3 bucket-admin permissions added to the ops policy' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  policy        : $ManagedPolicyName" -ForegroundColor Green
Write-Host "  new version   : $newVersionId (default)" -ForegroundColor Green
Write-Host "  statements    : $($oacSids -join ', ')" -ForegroundColor Green
Write-Host "  oac actions   : List/Create/GetOriginAccessControl (Resource *)" -ForegroundColor Green
Write-Host "  s3 bucket     : $FrontBktArn (policy + public-access-block)" -ForegroundColor Green
Write-Host ''
Write-Host '  Saved document (audit):' -ForegroundColor Yellow
Write-Host "    $mergedFile" -ForegroundColor DarkGray
Write-Host ''
Write-Warn 'Heads-up: the source-of-truth policy lives in create-iam-ops-user.ps1 (PHASE 2).'
Write-Warn 'Add these statements there too so a future re-run does not drop them again.'
Write-Host ''
Write-Ok 'The ops user can now run enable-cloudfront-oac.ps1.'
