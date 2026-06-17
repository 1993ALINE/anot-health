<#
================================================================================
 fix-iam-credentials.ps1  -  Make Anot Health (v40) authenticate to AWS with the
                             EC2 instance profile instead of a leftover IAM user
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 THE PROBLEM THIS FIXES:
   v40 is deployed and running, but loadSecrets.js fails with:
     "User: arn:aws:iam::625242092266:user/anot-s3-audio is not authorized to
      perform: ssm:GetParametersByPath"
   The EC2 instance profile (aws-elasticbeanstalk-ec2-role) is correct and DOES
   have ssm:GetParametersByPath. But static IAM-user keys (AWS_ACCESS_KEY_ID /
   AWS_SECRET_ACCESS_KEY for the old "anot-s3-audio" S3 user) are set as EB
   environment properties. The AWS SDK default credential chain prefers those
   static keys over the instance profile, so EVERY AWS call - including SSM -
   authenticates as anot-s3-audio, which cannot read SSM.

 WHAT THIS SCRIPT DOES (top to bottom):
   PRE-FLIGHT  Tooling + identity + environment checks.
   Phase 1     Discover the instance profile + IAM role actually attached to the
               EB environment, and confirm it is a ROLE (not a user).
   Phase 2     List ALL EB application:environment variables (names only) and
               FLAG the credential-related ones that will be removed.
   Phase 3     Grant the instance role read/write on the S3 audio bucket. This is
               REQUIRED before removing the keys: s3Storage.js currently uses the
               anot-s3-audio keys for audio upload/download. Once the keys are
               gone, S3 also falls through to the instance profile, so the role
               must be allowed to use the bucket or audio breaks.
   Phase 4     Remove the static AWS credential properties from EB and (re)assert
               USE_SSM=true in the same atomic update, then wait for the rollout.
   Phase 5     Verify EB health and the public endpoint, and print exactly how to
               confirm loadSecrets now reads SSM via the instance profile.

 COMPANION CODE FIX (defense in depth):
   src/config/loadSecrets.js now strips static AWS credential env vars at boot
   (when USE_SSM=true) before any AWS client is created, so even a future stray
   key in EB or a bundled .env can't hijack the identity. Rebuild/redeploy v40
   (scripts/deploy-v40-ssm.ps1) to ship that change; this script fixes the
   running environment immediately without a redeploy.

 USAGE:
   pwsh -File scripts/fix-iam-credentials.ps1 -DryRun   # rehearse, no changes
   pwsh -File scripts/fix-iam-credentials.ps1           # apply (prompts)
   pwsh -File scripts/fix-iam-credentials.ps1 -Force    # apply, no prompts
   pwsh -File scripts/fix-iam-credentials.ps1 -AudioBucket my-bucket
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun,
    [string]$AudioBucket
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId   = '625242092266'
$Region         = 'ap-southeast-1'
$EbAppName      = 'anot-backend'
$EbEnvName      = 'anot-backend-prod'
$SsmPrefix      = '/anot/prod'
$DefaultRole    = 'aws-elasticbeanstalk-ec2-role'   # fallback if discovery fails
$S3PolicyName   = 'anot-s3-audio-prod'
$HealthUrl      = 'https://api.anot.health/'
$DefaultBucket  = "anot-audio-$AwsAccountId"         # s3Storage.js default

# EB environment properties that carry static AWS credentials. Removing these is
# what forces the instance profile to be used. (Region vars are NOT credentials
# and are intentionally left alone.)
$CredentialEnvVars = @(
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_CREDENTIAL_PROFILES_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE'
)

$ProjectDir  = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'

$env:AWS_DEFAULT_REGION = $Region
$env:AWS_PAGER = ''                  # disable the AWS CLI v2 pager (silent-fail source)
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
# NativeCommandError before we read the real exit code. Retries with backoff,
# and on failure throws a detailed, copy-pasteable diagnostic. -SkipInDryRun
# marks a mutating call (skipped + printed in -DryRun).
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
    Write-Host '  CREDENTIAL FIX FAILED' -ForegroundColor Red
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
Write-Phase 'PRE-FLIGHT: tooling + identity + environment checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks only. No IAM or EB changes will be made.'
} else {
    Write-Step 'LIVE MODE: this run will modify the IAM role policy and EB environment.'
}

Write-Step 'Checking AWS CLI is installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Step "AWS CLI: $awsVersion"

Write-Step 'Verifying AWS identity (this is the OPERATOR identity, not the app)...'
$identity = Invoke-Aws sts get-caller-identity --output json | ConvertFrom-Json
Write-Step "Authenticated as: $($identity.Arn)"
if ($identity.Account -ne $AwsAccountId) {
    throw "Wrong AWS account: $($identity.Account) (expected $AwsAccountId)."
}

Write-Step "Confirming EB environment '$EbEnvName' exists..."
$envInfo = Invoke-Aws -Retries 3 -DelaySeconds 5 elasticbeanstalk describe-environments `
    --application-name $EbAppName --environment-names $EbEnvName --output json | ConvertFrom-Json
if (-not $envInfo.Environments -or @($envInfo.Environments).Count -eq 0) {
    throw "EB environment '$EbEnvName' not found in application '$EbAppName'."
}
$envObj = @($envInfo.Environments)[0]
Write-Diag "version: $($envObj.VersionLabel)  health: $($envObj.Health)  status: $($envObj.HealthStatus)"

# Read the full configuration once (used for env vars + instance profile).
Write-Step 'Reading current EB configuration settings...'
$cfg = Invoke-Aws -Retries 3 -DelaySeconds 5 elasticbeanstalk describe-configuration-settings `
    --application-name $EbAppName --environment-name $EbEnvName --output json | ConvertFrom-Json
$ebOpts = @($cfg.ConfigurationSettings[0].OptionSettings)

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Ok 'Pre-flight checks passed.'

# Helper: read a single EB option value by namespace+name, normalizing the shapes
# the CLI/ConvertFrom-Json can return (nested arrays, 0/1/many matches) to a
# clean trimmed string or $null.
function Get-EbOption {
    param([string]$Namespace, [string]$Name)
    $found = @($ebOpts | Where-Object { $_.Namespace -eq $Namespace -and $_.OptionName -eq $Name })
    if ($found.Count -eq 0) { return $null }
    $val = $found[0].Value
    while ($val -is [System.Array]) {
        if ($val.Count -eq 0) { return $null }
        $val = $val[0]
    }
    if ($null -eq $val) { return $null }
    $str = ([string]$val).Trim()
    if ([string]::IsNullOrEmpty($str)) { return $null }
    return $str
}

# ==============================================================================
# PHASE 1 - Discover the instance profile + IAM role attached to the environment
# ==============================================================================
Write-Phase 'PHASE 1: Discover the EB instance profile and IAM role'

$InstanceProfileName = Get-EbOption 'aws:autoscaling:launchconfiguration' 'IamInstanceProfile'
if ([string]::IsNullOrEmpty($InstanceProfileName)) {
    # Newer EB platforms expose it under aws:ec2:instances; fall back, then default.
    $InstanceProfileName = Get-EbOption 'aws:ec2:instances' 'IamInstanceProfile'
}
if ([string]::IsNullOrEmpty($InstanceProfileName)) {
    Write-Warn "Could not read IamInstanceProfile from the EB config; assuming '$DefaultRole'."
    $InstanceProfileName = $DefaultRole
}
Write-Step "EB instance profile: $InstanceProfileName"

# An instance profile can have a different ROLE name than the profile name. Look
# it up so we attach the S3 policy to the correct role.
Write-Step 'Resolving the IAM role behind that instance profile...'
$profileJson = Invoke-Aws -Retries 3 -DelaySeconds 5 `
    iam get-instance-profile --instance-profile-name $InstanceProfileName --output json | ConvertFrom-Json
$roles = @($profileJson.InstanceProfile.Roles)
if ($roles.Count -eq 0) {
    throw "Instance profile '$InstanceProfileName' has no role attached. Cannot grant S3 access."
}
$InstanceRole = $roles[0].RoleName
Write-Ok "Instance role: $InstanceRole (this is the identity the app SHOULD use)."

# ==============================================================================
# PHASE 2 - List EB env vars and flag credential-related ones
# ==============================================================================
Write-Phase 'PHASE 2: Inspect EB environment variables (names only)'

$envVars = @($ebOpts |
    Where-Object { $_.Namespace -eq 'aws:elasticbeanstalk:application:environment' } |
    ForEach-Object { $_.OptionName } |
    Sort-Object)

Write-Step "Found $($envVars.Count) environment propert(ies). Credential vars are flagged [CRED]:"
$presentCredVars = @()
foreach ($name in $envVars) {
    if ($CredentialEnvVars -contains $name) {
        $presentCredVars += $name
        Write-Host "    [CRED] $name" -ForegroundColor Yellow
    } else {
        Write-Host "           $name" -ForegroundColor DarkGray
    }
}

# Resolve the audio bucket: explicit param > EB S3_AUDIO_BUCKET > default.
if ([string]::IsNullOrEmpty($AudioBucket)) {
    $AudioBucket = Get-EbOption 'aws:elasticbeanstalk:application:environment' 'S3_AUDIO_BUCKET'
}
if ([string]::IsNullOrEmpty($AudioBucket)) { $AudioBucket = $DefaultBucket }
Write-Diag "audio bucket (for S3 grant): $AudioBucket"

if ($presentCredVars.Count -eq 0) {
    Write-Ok 'No static AWS credential properties found in the EB environment.'
    Write-Warn 'If the app still authenticates as anot-s3-audio, the keys are likely in a'
    Write-Warn 'bundled .env. The loadSecrets.js purge (rebuild + redeploy v40) removes those.'
} else {
    Write-Warn "Will remove $($presentCredVars.Count) credential propert(ies): $($presentCredVars -join ', ')"
}

# ==============================================================================
# PHASE 3 - Grant the instance role access to the S3 audio bucket
# ==============================================================================
# REQUIRED before key removal: s3Storage.js uses the AWS provider chain, so once
# the anot-s3-audio keys are gone, S3 also uses the instance profile. The role
# must be allowed to read/write the audio bucket or uploads/playback break.
Write-Phase 'PHASE 3: Grant the instance role read/write on the S3 audio bucket'

$s3Policy = [ordered]@{
    Version   = '2012-10-17'
    Statement = @(
        [ordered]@{
            Sid      = 'AnotAudioObjectRW'
            Effect   = 'Allow'
            Action   = @('s3:GetObject', 's3:PutObject', 's3:DeleteObject')
            Resource = "arn:aws:s3:::$AudioBucket/*"
        },
        [ordered]@{
            Sid      = 'AnotAudioBucketList'
            Effect   = 'Allow'
            Action   = @('s3:ListBucket', 's3:GetBucketLocation')
            Resource = "arn:aws:s3:::$AudioBucket"
        }
    )
}

$s3PolicyFile = Join-Path $ArtifactDir 'anot-s3-audio-policy.json'
$s3Policy | ConvertTo-Json -Depth 10 | Out-File -FilePath $s3PolicyFile -Encoding ascii
Write-Step "Wrote S3 policy document to $s3PolicyFile"
Write-Diag "grants: s3:GetObject/PutObject/DeleteObject on arn:aws:s3:::$AudioBucket/*"

Confirm-Step "Attach inline policy '$S3PolicyName' (S3 access to '$AudioBucket') to role '$InstanceRole'?"
Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "iam put-role-policy $S3PolicyName" `
    iam put-role-policy --role-name $InstanceRole `
    --policy-name $S3PolicyName --policy-document "file://$s3PolicyFile" | Out-Null
Write-Ok "Instance role '$InstanceRole' can now use the S3 audio bucket via the instance profile."

# ==============================================================================
# PHASE 4 - Remove static credentials from EB + (re)assert USE_SSM=true
# ==============================================================================
Write-Phase 'PHASE 4: Remove static AWS credentials from EB (atomic update)'

if ($presentCredVars.Count -eq 0) {
    Write-Ok 'Nothing to remove from EB (no credential properties present). Skipping update.'
} else {
    $removeArgs = $presentCredVars | ForEach-Object {
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=$_"
    }

    Confirm-Step "Remove $($presentCredVars.Count) credential propert(ies) from '$EbEnvName' and re-assert USE_SSM=true now?"
    Write-Step 'Submitting environment update (remove credentials + set USE_SSM=true)...'
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'update-environment (remove static AWS credentials)' `
        elasticbeanstalk update-environment `
        --application-name $EbAppName --environment-name $EbEnvName `
        --option-settings `
            "Namespace=aws:elasticbeanstalk:application:environment,OptionName=USE_SSM,Value=true" `
            "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SSM_REGION,Value=$Region" `
            "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SSM_PREFIX,Value=$SsmPrefix" `
        --options-to-remove $removeArgs | Out-Null

    if (-not $DryRun) {
        Write-Step 'Waiting for the environment to finish updating...'
        Invoke-Aws -SkipInDryRun elasticbeanstalk wait environment-updated `
            --application-name $EbAppName --environment-names $EbEnvName
        Write-Ok 'EB updated: static credentials removed; the app now uses the instance profile.'
    } else {
        Write-Ok "[DRY-RUN] would remove $($presentCredVars -join ', ') and wait for the environment update."
    }
}

# ==============================================================================
# PHASE 5 - Verify
# ==============================================================================
Write-Phase 'PHASE 5: Verify the fix'

if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: discovery + inspection passed. No IAM/EB changes were made.'
    Write-Warn 'Re-run without -DryRun to apply the S3 grant and remove the static credentials.'
    Write-Host ''
    return
}

Write-Step 'Fetching EB environment health...'
$envState = Invoke-Aws -Retries 3 -DelaySeconds 5 elasticbeanstalk describe-environments `
    --application-name $EbAppName --environment-names $EbEnvName --output json | ConvertFrom-Json
$envNow = @($envState.Environments)[0]
Write-Diag "version: $($envNow.VersionLabel)  health: $($envNow.Health)  status: $($envNow.HealthStatus)"

Write-Step "Querying public endpoint $HealthUrl ..."
try {
    $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 30
    Write-Diag "HTTP $($resp.StatusCode): $($resp.Content)"
    if ($resp.StatusCode -eq 200) { Write-Ok 'Endpoint responded 200.' }
} catch {
    Write-Warn "Health request failed: $($_.Exception.Message)"
}

Write-Host ''
Write-Host '  NEXT: confirm loadSecrets now reads SSM via the instance profile.' -ForegroundColor Yellow
Write-Host '  Tail the application logs and look for these lines (NOT an AccessDenied):' -ForegroundColor Yellow
Write-Host '    [loadSecrets] No static AWS credential env vars present - using the instance profile.' -ForegroundColor DarkGray
Write-Host '    [loadSecrets] Loaded N parameter(s) from SSM: ...' -ForegroundColor DarkGray
Write-Host '' 
Write-Host "  Pull logs with:" -ForegroundColor Yellow
Write-Host "    aws elasticbeanstalk request-environment-info --environment-name $EbEnvName --info-type tail" -ForegroundColor DarkGray
Write-Host "    aws elasticbeanstalk retrieve-environment-info  --environment-name $EbEnvName --info-type tail" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Functional checks:' -ForegroundColor Yellow
Write-Host '    [ ] Log in (DB password + JWT_SECRET come from SSM)' -ForegroundColor Yellow
Write-Host '    [ ] Upload/record a visit audio (S3 PutObject via instance profile)' -ForegroundColor Yellow
Write-Host '    [ ] Play back an existing audio (S3 GetObject presigned URL)' -ForegroundColor Yellow
Write-Host ''
Write-Host '  Defense in depth: rebuild + redeploy v40 to ship the loadSecrets.js purge:' -ForegroundColor Yellow
Write-Host '    pwsh -File scripts/deploy-v40-ssm.ps1' -ForegroundColor DarkGray
Write-Host ''
Write-Ok 'Credential fix complete.'
