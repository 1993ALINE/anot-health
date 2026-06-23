<#
================================================================================
update-ops-policy-eb-s3.ps1  -  Add S3 bucket creation permissions for
                                Elastic Beanstalk deployment
================================================================================
Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

WHY THIS EXISTS:
  Elastic Beanstalk deployments fail with:
    "User is not authorized to perform: s3:CreateBucket on resource: 
     arn:aws:s3:::elasticbeanstalk-ap-southeast-1-625242092266"
  
  EB needs to create temporary S3 buckets during deployment to store
  application versions and other deployment artifacts. This script grants
  the missing permissions to the anot-ops user.

WHAT THIS DOES:
  Reads the CURRENT DEFAULT version of the customer-managed policy
  'anot-ops-prod-policy', merges in one statement (idempotently, keyed by Sid),
  then publishes the merged document as a NEW DEFAULT policy version via
  'iam create-policy-version --set-as-default'.

THE STATEMENT ADDED (Sid):
  S3ElasticBeanstalkBuckets   s3:CreateBucket / GetBucketLocation /
                              GetBucketVersioning / ListBucket
                              (scoped to elasticbeanstalk-* buckets in ap-southeast-1)

ALREADY PRESENT (in create-iam-ops-user.ps1):
  s3:ListBucket / GetObject / PutObject on anot-audio and anot-frontend buckets.
  The EB deployment needs additional permissions to CREATE and configure the
  EB-managed buckets.

VERSION LIMIT: a managed policy keeps at most 5 versions. If 5 already exist we
  delete the OLDEST NON-DEFAULT version before publishing, so the call never
  fails with LimitExceeded.

SAFETY:
  * Idempotent: if the Sid is already present and unchanged, no new version is
    published.
  * -DryRun does every read-only step and writes the proposed merged document
    to disk for inspection, WITHOUT deleting versions or calling
    create-policy-version.
  * Mutating steps prompt for confirmation unless -Force / -SkipConfirm.

USAGE:
  powershell -File scripts/update-ops-policy-eb-s3.ps1 -DryRun   # rehearse
  powershell -File scripts/update-ops-policy-eb-s3.ps1           # apply (prompts)
  powershell -File scripts/update-ops-policy-eb-s3.ps1 -Force    # apply, no prompts
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

# Elastic Beanstalk creates buckets with naming pattern:
# elasticbeanstalk-{region}-{account-id}
$EbBucketPattern = "elasticbeanstalk-*"
$EbBucketArn     = "arn:aws:s3:::$EbBucketPattern"

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

function Test-AwsOk {
    [CmdletBinding(PositionalBinding = $false)]
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try   { & aws @CliArgs 2>&1 | Out-Null; $code = $LASTEXITCODE }
    catch { $code = 9001 }
    finally { $ErrorActionPreference = $prevEap }
    return ($code -eq 0)
}
#endregion

# ------------------------------------------------------------------------------
# Failure trap: name the phase, show the underlying error, exit non-zero.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  UPDATE OPS POLICY (EB S3) FAILED' -ForegroundColor Red
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
    Write-Warn 'DRY-RUN MODE: read-only checks only. Policy will not be modified.'
} else {
    Write-Step 'LIVE MODE: this run will modify the IAM policy.'
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
# PHASE 1 - Fetch current policy
# ==============================================================================
Write-Phase "PHASE 1: Fetch current policy '$ManagedPolicyName'"

Write-Step "Checking policy '$ManagedPolicyName' exists..."
$policyExists = Test-AwsOk iam get-policy --policy-arn $ManagedPolicyArn
if (-not $policyExists) {
    throw "Policy '$ManagedPolicyName' does not exist. Run create-iam-ops-user.ps1 first."
}
Write-Ok "Policy '$ManagedPolicyName' exists."

Write-Step 'Fetching default policy version...'
$policyRaw = Invoke-Aws iam get-policy --policy-arn $ManagedPolicyArn --output json
$policy = $policyRaw | ConvertFrom-Json
$defaultVersionId = $policy.Policy.DefaultVersionId
Write-Step "Default version: $defaultVersionId"

$policyDocRaw = Invoke-Aws iam get-policy-version --policy-arn $ManagedPolicyArn --version-id $defaultVersionId --output json
$policyDoc = ($policyDocRaw | ConvertFrom-Json).PolicyVersion.Document | ConvertTo-Json -Depth 10 | ConvertFrom-Json
Write-Ok "Fetched policy document (version $defaultVersionId)."

# ==============================================================================
# PHASE 2 - Build the new statement
# ==============================================================================
Write-Phase 'PHASE 2: Build the Elastic Beanstalk S3 statement'

$newStatement = [ordered]@{
    Sid      = 'S3ElasticBeanstalkBuckets'
    Effect   = 'Allow'
    Action   = @(
        's3:CreateBucket',
        's3:ListBucket',
        's3:GetBucketLocation',
        's3:GetBucketVersioning',
        's3:PutBucketVersioning'
    )
    Resource = $EbBucketArn
}

Write-Diag "New statement Sid: $($newStatement.Sid)"
Write-Diag "Actions: $($newStatement.Action -join ', ')"
Write-Diag "Resource: $($newStatement.Resource)"

# ==============================================================================
# PHASE 3 - Merge statements (idempotent by Sid)
# ==============================================================================
Write-Phase 'PHASE 3: Merge statement into policy (idempotent by Sid)'

$statements = [System.Collections.ArrayList]@()
$sids = @{}
$found = $false

foreach ($stmt in $policyDoc.Statement) {
    if ($stmt.Sid -eq $newStatement.Sid) {
        $found = $true
        $existingJson = ($stmt | ConvertTo-Json -Depth 5 -Compress)
        $newJson = ($newStatement | ConvertTo-Json -Depth 5 -Compress)
        if ($existingJson -eq $newJson) {
            Write-Ok "Statement '$($newStatement.Sid)' already present and identical - no change needed."
            $statements.Add($stmt) | Out-Null
        } else {
            Write-Step "Statement '$($newStatement.Sid)' present but differs - replacing it."
            $statements.Add($newStatement) | Out-Null
        }
    } else {
        $statements.Add($stmt) | Out-Null
    }
    if ($stmt.Sid) { $sids[$stmt.Sid] = $true }
}

if (-not $found) {
    Write-Step "Statement '$($newStatement.Sid)' not found - adding it."
    $statements.Add($newStatement) | Out-Null
}

$mergedPolicy = [ordered]@{
    Version   = $policyDoc.Version
    Statement = $statements.ToArray()
}

$mergedFile = Join-Path $ArtifactDir "anot-ops-policy-eb-s3-$Stamp.json"
$mergedJson = $mergedPolicy | ConvertTo-Json -Depth 10
$mergedJson | Out-File -FilePath $mergedFile -Encoding ascii

$compactLen = ($mergedJson -replace '\s', '').Length
Write-Step "Wrote merged policy to $mergedFile"
Write-Diag "compact policy size: $compactLen chars (limit = 6144)"
Write-Ok 'Policy merged successfully.'

if ($found -and ($existingJson -eq $newJson)) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Green
    Write-Host '  NO CHANGE NEEDED' -ForegroundColor Green
    Write-Host ('=' * 78) -ForegroundColor Green
    Write-Ok "Statement '$($newStatement.Sid)' already present and identical."
    Write-Ok 'Policy is already up to date. No new version will be published.'
    return
}

# ==============================================================================
# PHASE 4 - Prune old versions if at limit
# ==============================================================================
Write-Phase 'PHASE 4: Prune old policy versions if needed (5-version limit)'

$verRaw = Invoke-Aws iam list-policy-versions --policy-arn $ManagedPolicyArn --output json
$versions = @(($verRaw | ConvertFrom-Json).Versions)
Write-Step "Policy has $($versions.Count) version(s)."

if ($versions.Count -ge 5) {
    Write-Step '5 versions present; deleting oldest non-default version to make room.'
    $oldest = @($versions | Where-Object { -not $_.IsDefaultVersion } | Sort-Object { [datetime]$_.CreateDate })[0]
    if ($oldest) {
        Write-Step "Deleting version $($oldest.VersionId) (created $($oldest.CreateDate))."
        Invoke-Aws -SkipInDryRun iam delete-policy-version --policy-arn $ManagedPolicyArn --version-id $oldest.VersionId | Out-Null
        if ($DryRun) { Write-Ok "[DRY-RUN] would delete version $($oldest.VersionId)." }
        else         { Write-Ok "Deleted version $($oldest.VersionId)." }
    } else {
        Write-Warn 'All 5 versions are marked default (should never happen). Cannot prune.'
    }
} else {
    Write-Ok "Only $($versions.Count) version(s) present - no pruning needed."
}

# ==============================================================================
# PHASE 5 - Publish new default policy version
# ==============================================================================
Write-Phase 'PHASE 5: Publish new default policy version'

Confirm-Step "Publish the merged policy as a new default version of '$ManagedPolicyName'?"

Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'iam create-policy-version' `
    iam create-policy-version --policy-arn $ManagedPolicyArn `
    --policy-document "file://$mergedFile" --set-as-default | Out-Null

if ($DryRun) {
    Write-Ok "[DRY-RUN] would publish new policy version (not applied)."
    Write-Ok "Inspect the merged document at: $mergedFile"
} else {
    Write-Ok "Published new default policy version for '$ManagedPolicyName'."
}

# ==============================================================================
# SUCCESS
# ==============================================================================
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: Elastic Beanstalk S3 permissions added' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  Policy        : $ManagedPolicyName" -ForegroundColor Green
Write-Host "  Statement Sid : $($newStatement.Sid)" -ForegroundColor Green
Write-Host "  EB Bucket ARN : $EbBucketArn" -ForegroundColor Green
Write-Host ''
Write-Ok 'The anot-ops user can now create and manage Elastic Beanstalk S3 buckets.'
Write-Ok 'Retry your EB deployment.'
Write-Host ''
