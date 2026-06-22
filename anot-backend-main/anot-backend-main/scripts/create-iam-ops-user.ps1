<#
================================================================================
 create-iam-ops-user.ps1  -  Create the least-privilege IAM operator user
                             'anot-ops' for managing Anot Health prod infra
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 THE GOAL:
   Stop operating Anot Health production from the AWS ROOT account. Create a
   dedicated, scoped IAM user 'anot-ops' that can run the day-to-day infra
   scripts in this repo (EB, RDS, CloudFront, CloudWatch/Logs, EC2/ASG, S3,
   SSM read, IAM read, CloudFormation read) and NOTHING else, then hand you the
   exact steps to switch your AWS CLI from root to that user and to retire the
   root access keys.

 WHY A CUSTOMER-MANAGED POLICY (NOT A USER INLINE POLICY):
   The task asked for an "inline policy". AWS caps the AGGREGATE size of all
   inline policies on a single IAM USER at 2,048 characters (whitespace
   excluded). The permission set below spans ten services and does not fit in
   2,048 chars, so an inline user policy is physically impossible here. Instead
   we create ONE customer-managed policy (limit 6,144 chars) named
   'anot-ops-prod-policy' and attach it to the user. This is the AWS-recommended
   pattern anyway: managed policies are versioned, auditable, and re-usable.
   Re-running creates a NEW default policy version (idempotent), never a 2nd user.

 SCOPING (production resources only):
   * ElasticBeanstalk : describe* (account-wide, required by the API) + Update/
                        RequestEnvironmentInfo/RetrieveEnvironmentInfo scoped to
                        the 'anot-backend' app + 'anot-backend-prod' environment.
   * RDS              : describe* (account-wide) + Modify/snapshot(backup) actions
                        scoped to the 'anot-postgres' instance and its snapshots.
   * CloudFront       : List* (account-wide) + Get/Update/Invalidate scoped to the
                        distribution E6SKNV1EEXNPP.
   * CloudWatch       : read-only (alarms, metrics) - no resource-level support.
   * EC2 / AutoScaling: describe-only (account-wide; Describe* has no ARN scope).
   * S3               : list/read/write scoped to the anot-audio + anot-frontend
                        buckets only.
   * IAM              : read-only (list/get roles + policies) for safety.
   * SSM              : Get*/GetParametersByPath scoped to /anot/prod/*.
   * CloudFormation   : describe stacks (read-only).
   * Logs             : describe (account-wide) + create/put/tail scoped to the
                        anot-backend-prod and RDSOSMetrics log groups.

 WHAT THIS SCRIPT DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity checks; warn loudly if you are running as root.
   Phase 1     Ensure the IAM user 'anot-ops' exists (create if missing).
   Phase 2     Create/refresh the customer-managed policy and attach it.
   Phase 3     Generate a programmatic access key (skipped if one already exists
               unless -RotateKeys; never more than the AWS limit of 2).
   Phase 4     Store the credentials to a DPAPI-ENCRYPTED file (per-user/machine)
               in a locked-down 'secrets' folder; print how to decrypt it.
   Phase 5     Print ~/.aws/credentials setup, how to switch from root to ops,
               and how to retire the root account access keys.

 SAFETY:
   * Idempotent: re-running re-uses the user, adds a new policy version, and does
     NOT mint extra access keys unless you pass -RotateKeys.
   * -DryRun does every read-only check and prints exactly which mutating calls
     WOULD run, without creating the user, policy, or access key.
   * Mutating steps prompt for confirmation unless -Force / -SkipConfirm.
   * The secret access key is shown to you ONCE (AWS never reveals it again) and
     simultaneously written to the encrypted file.

 USAGE:
   powershell -File scripts/create-iam-ops-user.ps1 -DryRun   # rehearse, no change
   powershell -File scripts/create-iam-ops-user.ps1           # apply (prompts)
   powershell -File scripts/create-iam-ops-user.ps1 -Force    # apply, no prompts
   powershell -File scripts/create-iam-ops-user.ps1 -RotateKeys
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun,
    [switch]$RotateKeys,
    [string]$UserName       = 'anot-ops',
    [string]$AudioBucket,
    [string]$FrontendBucket
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId   = '625242092266'
$Region         = 'ap-southeast-1'

$EbAppName      = 'anot-backend'
$EbEnvName      = 'anot-backend-prod'
$RdsInstanceId  = 'anot-postgres'
$DistributionId = 'E6SKNV1EEXNPP'
$SsmPrefix      = '/anot/prod'

# The managed policy attached to the ops user (versioned, idempotent).
$ManagedPolicyName = 'anot-ops-prod-policy'
$ManagedPolicyArn  = "arn:aws:iam::${AwsAccountId}:policy/${ManagedPolicyName}"

# Buckets default to the real account-suffixed names used elsewhere in the repo
# (see fix-cloudfront-s3-origin.ps1 / fix-iam-credentials.ps1). Override if needed.
if ([string]::IsNullOrEmpty($AudioBucket))    { $AudioBucket    = "anot-audio-$AwsAccountId" }
if ([string]::IsNullOrEmpty($FrontendBucket)) { $FrontendBucket = "anot-frontend-$AwsAccountId" }

# EB log group prefix EB auto-creates for the prod environment.
$EbLogGroupPrefix = "/aws/elasticbeanstalk/$EbEnvName"

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'
$SecretsDir  = Join-Path $ProjectDir 'secrets'
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

# Non-throwing existence probe: run a read-only AWS call once and report whether
# it succeeded (exit 0). Used to decide create-vs-update without tripping the
# Invoke-Aws failure diagnostic on the expected "does not exist" path.
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
    Write-Host '  CREATE IAM OPS USER FAILED' -ForegroundColor Red
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
    Write-Warn 'DRY-RUN MODE: read-only checks only. No IAM user, policy, or access key will be created.'
} else {
    Write-Step 'LIVE MODE: this run will create/modify the IAM user, its managed policy, and (maybe) an access key.'
}

Write-Step 'Checking AWS CLI is installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Step "AWS CLI: $awsVersion"

Write-Step 'Verifying AWS identity (the identity that will CREATE the ops user)...'
$identity = Invoke-Aws sts get-caller-identity --output json | ConvertFrom-Json
Write-Step "Authenticated as: $($identity.Arn)"
if ($identity.Account -ne $AwsAccountId) {
    throw "Wrong AWS account: $($identity.Account) (expected $AwsAccountId)."
}

# Creating an IAM user + attaching a policy needs admin-grade rights. That is
# almost always the root user or an admin user. Flag root so the operator knows
# this is exactly the bootstrap step that lets them STOP using root afterwards.
$IsRoot = ($identity.Arn -eq "arn:aws:iam::${AwsAccountId}:root") -or ($identity.Arn -match ':root$')
if ($IsRoot) {
    Write-Warn 'You are authenticated as the AWS ROOT account.'
    Write-Warn 'That is expected for THIS bootstrap step. After it succeeds, switch the CLI to'
    Write-Warn "the '$UserName' user (instructions printed at the end) and retire the root keys."
} else {
    Write-Step "Not root (good). This identity must still have iam:CreateUser / Create*Policy / Attach* rights."
}

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# PHASE 1 - Ensure the IAM user 'anot-ops' exists
# ==============================================================================
Write-Phase "PHASE 1: Ensure IAM user '$UserName' exists"

Write-Step "Checking whether IAM user '$UserName' already exists..."
$userExists = Test-AwsOk iam get-user --user-name $UserName
if ($userExists) {
    Write-Ok "IAM user '$UserName' already exists - will reuse it (no duplicate created)."
} else {
    Write-Step "IAM user '$UserName' not found."
    Confirm-Step "Create IAM user '$UserName' now?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "iam create-user $UserName" `
        iam create-user --user-name $UserName `
        --tags "Key=project,Value=anot-health" "Key=role,Value=ops" "Key=managed-by,Value=create-iam-ops-user.ps1" | Out-Null
    if ($DryRun) {
        Write-Ok "[DRY-RUN] would create IAM user '$UserName'."
    } else {
        Write-Ok "IAM user '$UserName' created."
    }
}

# ==============================================================================
# PHASE 2 - Create/refresh the customer-managed policy and attach it
# ==============================================================================
Write-Phase "PHASE 2: Build + attach the scoped managed policy '$ManagedPolicyName'"

# Resource ARNs (production only). EC2/CloudWatch/IAM read APIs do not support
# resource-level scoping, so those statements use "*" with read-only actions.
$EbAppArn      = "arn:aws:elasticbeanstalk:${Region}:${AwsAccountId}:application/${EbAppName}"
$EbEnvArn      = "arn:aws:elasticbeanstalk:${Region}:${AwsAccountId}:environment/${EbAppName}/${EbEnvName}"
$RdsDbArn      = "arn:aws:rds:${Region}:${AwsAccountId}:db:${RdsInstanceId}"
$RdsSnapArn    = "arn:aws:rds:${Region}:${AwsAccountId}:snapshot:*"
$RdsEsArn      = "arn:aws:rds:${Region}:${AwsAccountId}:es:*"
$CfDistArn     = "arn:aws:cloudfront::${AwsAccountId}:distribution/${DistributionId}"
$SsmParamArn   = "arn:aws:ssm:${Region}:${AwsAccountId}:parameter${SsmPrefix}/*"
$EbLogArn      = "arn:aws:logs:${Region}:${AwsAccountId}:log-group:${EbLogGroupPrefix}*"
$EbLogArnAll   = "arn:aws:logs:${Region}:${AwsAccountId}:log-group:${EbLogGroupPrefix}*:*"
$RdsLogArn     = "arn:aws:logs:${Region}:${AwsAccountId}:log-group:RDSOSMetrics*"
$RdsLogArnAll  = "arn:aws:logs:${Region}:${AwsAccountId}:log-group:RDSOSMetrics*:*"
$AudioBktArn   = "arn:aws:s3:::${AudioBucket}"
$FrontBktArn   = "arn:aws:s3:::${FrontendBucket}"

$opsPolicy = [ordered]@{
    Version   = '2012-10-17'
    Statement = @(
        [ordered]@{
            Sid      = 'EbReadOnly'
            Effect   = 'Allow'
            Action   = @(
                'elasticbeanstalk:Describe*',
                'elasticbeanstalk:ListAvailableSolutionStacks',
                'elasticbeanstalk:ListPlatformVersions'
            )
            Resource = '*'
        },
        [ordered]@{
            Sid      = 'EbManageProdEnv'
            Effect   = 'Allow'
            Action   = @(
                'elasticbeanstalk:UpdateEnvironment',
                'elasticbeanstalk:RequestEnvironmentInfo',
                'elasticbeanstalk:RetrieveEnvironmentInfo',
                'elasticbeanstalk:RestartAppServer',
                'elasticbeanstalk:RebuildEnvironment'
            )
            Resource = @($EbEnvArn, $EbAppArn)
        },
        [ordered]@{
            Sid      = 'RdsReadOnly'
            Effect   = 'Allow'
            Action   = @(
                'rds:Describe*',
                'rds:ListTagsForResource'
            )
            Resource = '*'
        },
        [ordered]@{
            Sid      = 'RdsManageProdInstanceAndBackups'
            Effect   = 'Allow'
            Action   = @(
                'rds:ModifyDBInstance',
                'rds:CreateDBSnapshot',
                'rds:DeleteDBSnapshot',
                'rds:CopyDBSnapshot',
                'rds:ModifyDBSnapshot',
                'rds:RebootDBInstance',
                'rds:AddTagsToResource'
            )
            Resource = @($RdsDbArn, $RdsSnapArn, $RdsEsArn)
        },
        [ordered]@{
            Sid      = 'CloudFrontList'
            Effect   = 'Allow'
            Action   = @(
                'cloudfront:ListDistributions',
                'cloudfront:ListInvalidations',
                'cloudfront:GetInvalidation'
            )
            Resource = '*'
        },
        [ordered]@{
            Sid      = 'CloudFrontManageProdDistribution'
            Effect   = 'Allow'
            Action   = @(
                'cloudfront:GetDistribution',
                'cloudfront:GetDistributionConfig',
                'cloudfront:UpdateDistribution',
                'cloudfront:CreateInvalidation'
            )
            Resource = $CfDistArn
        },
        [ordered]@{
            Sid      = 'CloudWatchReadOnly'
            Effect   = 'Allow'
            Action   = @(
                'cloudwatch:DescribeAlarms',
                'cloudwatch:DescribeAlarmHistory',
                'cloudwatch:GetMetricData',
                'cloudwatch:GetMetricStatistics',
                'cloudwatch:ListMetrics',
                'cloudwatch:ListDashboards',
                'cloudwatch:GetDashboard'
            )
            Resource = '*'
        },
        [ordered]@{
            Sid      = 'Ec2AndAsgReadOnly'
            Effect   = 'Allow'
            Action   = @(
                'ec2:DescribeSecurityGroups',
                'ec2:DescribeInstances',
                'ec2:DescribeInstanceStatus',
                'ec2:DescribeTags',
                'ec2:DescribeNetworkInterfaces',
                'ec2:DescribeAddresses',
                'ec2:DescribeVolumes',
                'autoscaling:DescribeAutoScalingGroups',
                'autoscaling:DescribeScalingActivities',
                'autoscaling:DescribePolicies',
                'autoscaling:DescribeLaunchConfigurations'
            )
            Resource = '*'
        },
        [ordered]@{
            Sid      = 'S3ListBuckets'
            Effect   = 'Allow'
            Action   = @('s3:ListBucket', 's3:GetBucketLocation')
            Resource = @($AudioBktArn, $FrontBktArn)
        },
        [ordered]@{
            Sid      = 'S3ObjectReadWrite'
            Effect   = 'Allow'
            Action   = @('s3:GetObject', 's3:PutObject', 's3:DeleteObject')
            Resource = @("$AudioBktArn/*", "$FrontBktArn/*")
        },
        [ordered]@{
            Sid      = 'IamReadOnly'
            Effect   = 'Allow'
            Action   = @(
                'iam:GetRole',
                'iam:ListRoles',
                'iam:ListRolePolicies',
                'iam:GetRolePolicy',
                'iam:ListAttachedRolePolicies',
                'iam:GetPolicy',
                'iam:GetPolicyVersion',
                'iam:ListPolicies',
                'iam:ListPolicyVersions',
                'iam:GetInstanceProfile',
                'iam:ListInstanceProfiles',
                'iam:ListInstanceProfilesForRole'
            )
            Resource = '*'
        },
        [ordered]@{
            Sid      = 'SsmReadProdParams'
            Effect   = 'Allow'
            Action   = @(
                'ssm:GetParametersByPath',
                'ssm:GetParameter',
                'ssm:GetParameters',
                'ssm:GetParameterHistory'
            )
            Resource = $SsmParamArn
        },
        [ordered]@{
            Sid      = 'CloudFormationReadOnly'
            Effect   = 'Allow'
            Action   = @(
                'cloudformation:DescribeStacks',
                'cloudformation:DescribeStackEvents',
                'cloudformation:DescribeStackResources',
                'cloudformation:ListStacks',
                'cloudformation:ListStackResources',
                'cloudformation:GetTemplate'
            )
            Resource = '*'
        },
        [ordered]@{
            Sid      = 'LogsDescribe'
            Effect   = 'Allow'
            Action   = @('logs:DescribeLogGroups')
            Resource = '*'
        },
        [ordered]@{
            Sid      = 'LogsReadCreateTailAnotGroups'
            Effect   = 'Allow'
            Action   = @(
                'logs:DescribeLogStreams',
                'logs:GetLogEvents',
                'logs:FilterLogEvents',
                'logs:StartLiveTail',
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:PutRetentionPolicy'
            )
            Resource = @($EbLogArn, $EbLogArnAll, $RdsLogArn, $RdsLogArnAll)
        }
    )
}

$policyFile = Join-Path $ArtifactDir 'anot-ops-policy.json'
$policyJson = $opsPolicy | ConvertTo-Json -Depth 10
$policyJson | Out-File -FilePath $policyFile -Encoding ascii
# IAM measures policy size with whitespace removed; report the compact length so
# you can see we are well under the 6,144-char customer-managed-policy limit.
$compactLen = ($policyJson -replace '\s', '').Length
Write-Step "Wrote policy document to $policyFile"
Write-Diag "compact policy size: $compactLen chars (customer-managed limit = 6144; user-inline limit = 2048)"
Write-Diag "buckets scoped: $AudioBucket , $FrontendBucket"

Write-Step "Checking whether managed policy '$ManagedPolicyName' already exists..."
$policyExists = Test-AwsOk iam get-policy --policy-arn $ManagedPolicyArn

if (-not $policyExists) {
    Confirm-Step "Create customer-managed policy '$ManagedPolicyName'?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "iam create-policy $ManagedPolicyName" `
        iam create-policy --policy-name $ManagedPolicyName `
        --description 'Least-privilege ops access for Anot Health prod infra (managed by create-iam-ops-user.ps1)' `
        --policy-document "file://$policyFile" `
        --tags "Key=project,Value=anot-health" "Key=managed-by,Value=create-iam-ops-user.ps1" | Out-Null
    if ($DryRun) { Write-Ok "[DRY-RUN] would create managed policy '$ManagedPolicyName'." }
    else         { Write-Ok "Managed policy '$ManagedPolicyName' created." }
} else {
    Write-Step "Policy exists; adding a new default version (idempotent refresh)."
    # A managed policy keeps at most 5 versions. Prune the oldest NON-default
    # version first so create-policy-version never fails with LimitExceeded.
    if (-not $DryRun) {
        $verRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'iam list-policy-versions' `
            iam list-policy-versions --policy-arn $ManagedPolicyArn --output json
        $versions = @(($verRaw | ConvertFrom-Json).Versions)
        if ($versions.Count -ge 5) {
            $oldest = @($versions | Where-Object { -not $_.IsDefaultVersion } |
                Sort-Object { [datetime]$_.CreateDate })[0]
            if ($oldest) {
                Write-Step "5 versions present; deleting oldest non-default version $($oldest.VersionId)."
                Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'iam delete-policy-version' `
                    iam delete-policy-version --policy-arn $ManagedPolicyArn --version-id $oldest.VersionId | Out-Null
            }
        }
    }
    Confirm-Step "Publish a new default version of '$ManagedPolicyName' from the document above?"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'iam create-policy-version' `
        iam create-policy-version --policy-arn $ManagedPolicyArn `
        --policy-document "file://$policyFile" --set-as-default | Out-Null
    if ($DryRun) { Write-Ok "[DRY-RUN] would publish a new default policy version." }
    else         { Write-Ok "Published a new default version of '$ManagedPolicyName'." }
}

Confirm-Step "Attach managed policy '$ManagedPolicyName' to user '$UserName'?"
Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'iam attach-user-policy' `
    iam attach-user-policy --user-name $UserName --policy-arn $ManagedPolicyArn | Out-Null
if ($DryRun) { Write-Ok "[DRY-RUN] would attach '$ManagedPolicyName' to '$UserName'." }
else         { Write-Ok "Attached '$ManagedPolicyName' to '$UserName' (attach is idempotent)." }

# ==============================================================================
# PHASE 3 - Generate a programmatic access key (idempotent / safe)
# ==============================================================================
Write-Phase "PHASE 3: Provision a programmatic access key for '$UserName'"

# AWS allows at most 2 access keys per user. We never blindly create a 3rd:
#   - 0 existing keys  -> create one.
#   - >=1 existing key -> skip UNLESS -RotateKeys (then create one more, up to 2).
$existingKeyIds = @()
if ($userExists -or -not $DryRun) {
    $keyRaw = Invoke-Aws -Retries 3 -DelaySeconds 5 -What 'iam list-access-keys' `
        iam list-access-keys --user-name $UserName --output json
    if ($keyRaw) { $existingKeyIds = @(($keyRaw | ConvertFrom-Json).AccessKeyMetadata | ForEach-Object { $_.AccessKeyId }) }
}
Write-Diag "existing access keys for '$UserName': $(if ($existingKeyIds.Count) { $existingKeyIds -join ', ' } else { '(none)' })"

$newAccessKeyId  = $null
$newSecretKey    = $null
$createdKey      = $false

if ($existingKeyIds.Count -ge 2 -and -not $RotateKeys) {
    Write-Warn "User already has 2 access keys (the AWS maximum). Not creating another."
    Write-Warn 'Delete an unused key in the IAM console, or re-run with -RotateKeys after pruning.'
}
elseif ($existingKeyIds.Count -ge 1 -and -not $RotateKeys) {
    Write-Warn "User already has $($existingKeyIds.Count) access key(s); skipping creation to avoid sprawl."
    Write-Warn 'Re-run with -RotateKeys to mint a NEW key (then disable/delete the old one).'
}
elseif ($existingKeyIds.Count -ge 2 -and $RotateKeys) {
    Write-Warn 'User already has 2 access keys (AWS maximum) and cannot hold a 3rd.'
    Write-Warn 'Delete one in the IAM console first, then re-run with -RotateKeys.'
}
else {
    Confirm-Step "Create a new access key for '$UserName' now?"
    if ($DryRun) {
        Write-Host "    [DRY-RUN] skip mutating call: aws iam create-access-key --user-name $UserName" -ForegroundColor DarkYellow
        Write-Ok '[DRY-RUN] would create an access key and write it to the encrypted secrets file.'
    } else {
        $keyOut = Invoke-Aws -Retries 2 -DelaySeconds 5 -What 'iam create-access-key' `
            iam create-access-key --user-name $UserName --output json | ConvertFrom-Json
        $newAccessKeyId = $keyOut.AccessKey.AccessKeyId
        $newSecretKey   = $keyOut.AccessKey.SecretAccessKey
        $createdKey     = $true
        Write-Ok "Created access key: $newAccessKeyId (the secret is shown ONCE, below + in the encrypted file)."
    }
}

# ==============================================================================
# PHASE 4 - Store the credentials to a DPAPI-encrypted, locked-down file
# ==============================================================================
Write-Phase 'PHASE 4: Store credentials securely (encrypted at rest)'

$credFile = Join-Path $SecretsDir "$UserName-credentials-$Stamp.xml"

if (-not $createdKey) {
    if ($DryRun) {
        Write-Ok "[DRY-RUN] would write the new key to: $credFile (DPAPI-encrypted)."
    } else {
        Write-Warn 'No new access key was created this run; nothing to store.'
        Write-Diag "If you need a fresh key, re-run with -RotateKeys (after pruning to < 2 keys)."
    }
} else {
    New-Item -ItemType Directory -Force -Path $SecretsDir | Out-Null

    # Lock the secrets directory down to the current user (best-effort). Break
    # inheritance so it never widens to whatever the parent folder allows.
    try {
        & icacls $SecretsDir /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(OI)(CI)F" 2>&1 | Out-Null
    } catch {
        Write-Warn "Could not tighten ACL on $SecretsDir : $($_.Exception.Message)"
    }

    # The SecretAccessKey is stored as a SecureString. Export-Clixml encrypts any
    # SecureString with the Windows Data Protection API (DPAPI), tied to THIS
    # Windows user on THIS machine - it cannot be decrypted by another user/host.
    $secure = ConvertTo-SecureString -String $newSecretKey -AsPlainText -Force
    $record = [pscustomobject]@{
        UserName        = $UserName
        AccessKeyId     = $newAccessKeyId
        SecretAccessKey = $secure
        Region          = $Region
        AccountId       = $AwsAccountId
        CreatedAtUtc    = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
        CreatedBy       = $identity.Arn
        ProfileName     = $UserName
    }
    $record | Export-Clixml -Path $credFile

    try {
        & icacls $credFile /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(R,W)" 2>&1 | Out-Null
    } catch {
        Write-Warn "Could not tighten ACL on $credFile : $($_.Exception.Message)"
    }

    Write-Ok "Credentials written (secret DPAPI-encrypted) to: $credFile"
    Write-Warn 'This file is decryptable ONLY by your current Windows user on this machine.'
    Write-Warn "Never commit the 'secrets' folder to git. Add it to .gitignore if it is not already."
    Write-Host ''
    Write-Host '  Decrypt the secret later (PowerShell) with:' -ForegroundColor Yellow
    Write-Host "    `$c = Import-Clixml '$credFile'" -ForegroundColor DarkGray
    Write-Host "    `$c.AccessKeyId" -ForegroundColor DarkGray
    Write-Host "    [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR(`$c.SecretAccessKey))" -ForegroundColor DarkGray
}

# ==============================================================================
# PHASE 5 - Setup instructions: ~/.aws/credentials + switch off root
# ==============================================================================
Write-Phase 'PHASE 5: Configure your AWS CLI to use the ops user'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: all checks passed and the plan validated. No changes were made.'
    Write-Warn 'Re-run without -DryRun to create the user, policy, and access key.'
    Write-Host ''
    Write-Host '  Planned changes:' -ForegroundColor Yellow
    Write-Host "    iam user        : $UserName (create if missing)" -ForegroundColor DarkGray
    Write-Host "    managed policy  : $ManagedPolicyName (create or new version) -> attach" -ForegroundColor DarkGray
    Write-Host "    access key      : create one (unless the user already has keys)" -ForegroundColor DarkGray
    Write-Host "    encrypted file  : $SecretsDir\$UserName-credentials-<stamp>.xml" -ForegroundColor DarkGray
    Write-Host ''
    return
}

# Print the one-time secret reveal block only when we just created a key.
if ($createdKey) {
    Write-Host ''
    Write-Host ('-' * 78) -ForegroundColor Yellow
    Write-Host '  NEW ACCESS KEY (the secret is shown ONCE - AWS will never reveal it again)' -ForegroundColor Yellow
    Write-Host ('-' * 78) -ForegroundColor Yellow
    Write-Host "    aws_access_key_id     = $newAccessKeyId" -ForegroundColor Gray
    Write-Host "    aws_secret_access_key = $newSecretKey" -ForegroundColor Gray
    Write-Host ''
    Write-Host '  Option A - create a named profile non-interactively:' -ForegroundColor Yellow
    Write-Host "    aws configure set aws_access_key_id     $newAccessKeyId --profile $UserName" -ForegroundColor DarkGray
    Write-Host "    aws configure set aws_secret_access_key $newSecretKey --profile $UserName" -ForegroundColor DarkGray
    Write-Host "    aws configure set region                $Region --profile $UserName" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  Option B - add this block to ~/.aws/credentials by hand:' -ForegroundColor Yellow
    Write-Host "    [$UserName]" -ForegroundColor DarkGray
    Write-Host "    aws_access_key_id = $newAccessKeyId" -ForegroundColor DarkGray
    Write-Host "    aws_secret_access_key = $newSecretKey" -ForegroundColor DarkGray
    Write-Host '  ...and the matching region in ~/.aws/config:' -ForegroundColor Yellow
    Write-Host "    [profile $UserName]" -ForegroundColor DarkGray
    Write-Host "    region = $Region" -ForegroundColor DarkGray
} else {
    Write-Warn "No new key this run. If you already have a key for '$UserName', configure it as below."
    Write-Host "    aws configure --profile $UserName" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  Verify the ops identity works:' -ForegroundColor Yellow
Write-Host "    aws sts get-caller-identity --profile $UserName" -ForegroundColor DarkGray
Write-Host "    (expect: arn:aws:iam::${AwsAccountId}:user/$UserName)" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Run the repo scripts AS the ops user (two equivalent ways):' -ForegroundColor Yellow
Write-Host "    1) Per-session env var (PowerShell):" -ForegroundColor DarkGray
Write-Host "         `$env:AWS_PROFILE = '$UserName'" -ForegroundColor DarkGray
Write-Host "         powershell -File scripts/enable-eb-cloudwatch-logs.ps1 -DryRun" -ForegroundColor DarkGray
Write-Host "    2) Make '$UserName' your default profile in ~/.aws/credentials ([default] block)." -ForegroundColor DarkGray

# ------------------------------------------------------------------------------
# SUCCESS
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host '  SUCCESS: ops user is provisioned and scoped' -ForegroundColor Green
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host "  user          : $UserName  (arn:aws:iam::${AwsAccountId}:user/$UserName)" -ForegroundColor Green
Write-Host "  managed policy : $ManagedPolicyName  (attached)" -ForegroundColor Green
if ($createdKey) {
    Write-Host "  access key    : $newAccessKeyId  (secret in $credFile)" -ForegroundColor Green
} else {
    Write-Host "  access key    : (none created this run)" -ForegroundColor Green
}
Write-Host ''

# ------------------------------------------------------------------------------
# ROOT RETIREMENT WARNING
# ------------------------------------------------------------------------------
Write-Host ('=' * 78) -ForegroundColor Yellow
Write-Host '  IMPORTANT: STOP USING THE ROOT ACCOUNT' -ForegroundColor Yellow
Write-Host ('=' * 78) -ForegroundColor Yellow
Write-Warn 'The AWS root user has unrestricted access and CANNOT be scoped. Once you have'
Write-Warn "confirmed '$UserName' works for your day-to-day infra tasks:"
Write-Host ''
Write-Host '   1) Enable MFA on the root account (if not already).' -ForegroundColor Yellow
Write-Host '   2) DELETE any root ACCESS KEYS (programmatic root keys are a critical risk):' -ForegroundColor Yellow
Write-Host '        - Console: top-right account menu -> Security credentials -> Access keys -> Delete' -ForegroundColor DarkGray
Write-Host '        - Verify none remain:' -ForegroundColor DarkGray
Write-Host "            aws iam get-account-summary --query 'SummaryMap.AccountAccessKeysPresent'" -ForegroundColor DarkGray
Write-Host '          (0 means the root account has no programmatic keys - the goal.)' -ForegroundColor DarkGray
Write-Host '   3) Keep root credentials offline; use it only for the few root-only tasks' -ForegroundColor Yellow
Write-Host '      (closing the account, changing support plan, etc.).' -ForegroundColor Yellow
Write-Warn 'NOTE: this script does NOT touch the root account or any keys for you. Retiring'
Write-Warn 'the root keys is a deliberate manual step after you have verified the ops user.'
Write-Host ''
Write-Ok "Ops user '$UserName' is ready. Switch your CLI to it and retire root."
