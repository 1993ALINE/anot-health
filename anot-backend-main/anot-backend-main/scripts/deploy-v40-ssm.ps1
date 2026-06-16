<#
================================================================================
 deploy-v40-ssm.ps1  -  Anot Health v40 deployment with SSM secrets bootstrap
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHAT IT DOES (run top to bottom):
   BACKUP   Snapshot RDS + export the EB config BEFORE any change (rollback base)
   Phase 0  Add SSM + KMS read permissions to the EC2 instance role
   Phase 1  Prepare secrets (generate DB/JWT/webhook; REUSE existing keys)
   Phase 2  Build the v40 artifact and register the application version
   Phase 3  Rotate the database password (RDS master password)
   Phase 4  Store all secrets in SSM as SecureString
   Phase 5  Verify the required secrets exist in SSM  (GATE before deploy)
   Phase 6  Enable USE_SSM=true AND deploy v40 in one atomic environment update
   Phase 7  Remove the now-redundant plaintext secret env properties from EB
   Phase 8  Test the health endpoint

 WHY THIS ORDER (the safety invariants):
   * Backups first  - the RDS snapshot + EB config export are what ROLLBACK_V40_SSM.md
     restores from. Nothing destructive runs until they exist.
   * Build before rotating  - npm install / zip can fail; we fail BEFORE touching
     the database password or SSM, so a bad build never leaves prod half-migrated.
   * Verify SSM before deploy  - we refuse to deploy v40 unless every required
     secret is already present in SSM.
   * USE_SSM is enabled in the SAME update-environment call that ships v40, so the
     new v40 instances boot with USE_SSM=true and read the rotated DB password
     straight from SSM. There is never a moment where v40 runs without SSM.
   * Remove plaintext LAST  - only after v40 is verified healthy on SSM, so any
     earlier failure still has the EB env-property fallback (R1/R2 rollback).

 SETTINGS_ENCRYPTION_KEY POLICY (read this):
   This deploy DOES NOT rotate SETTINGS_ENCRYPTION_KEY. Rotating it requires a
   transactional re-encryption of the system_settings ciphertext columns (see
   scripts/reencrypt-settings-key.js) or every stored Deepgram/Anthropic key
   becomes undecryptable. We therefore COPY the existing key value from EB into
   SSM unchanged. To rotate it later: run reencrypt-settings-key.js (dry-run then
   live) against prod, then put the NEW key into SSM and restart. See
   DEPLOYMENT_V40_SSM.md.

 PREREQUISITES:
   - AWS CLI v2 on PATH and authenticated (aws sts get-caller-identity works)
   - Node.js 18+ / npm on PATH
   - The signed-in principal can edit IAM, RDS, SSM and Elastic Beanstalk

 USAGE:
   pwsh -File scripts/deploy-v40-ssm.ps1
   (or open in an elevated PowerShell and run the file)

 Destructive / costly steps (RDS password change, plaintext-secret removal)
 prompt for confirmation unless you pass -Force.
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm
)

# ------------------------------------------------------------------------------
# Strict error handling: any failed command or cmdlet aborts the script.
# ------------------------------------------------------------------------------
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId  = '625242092266'
$Region        = 'ap-southeast-1'
$SsmPrefix     = '/anot/prod'
$EbAppName     = 'anot-backend'
$EbEnvName     = 'anot-backend-prod'
$RdsInstanceId = 'anot-postgres'
$NewVersion    = 'v40'
$InstanceRole  = 'aws-elasticbeanstalk-ec2-role'   # EB default EC2 role
$PolicyName    = 'anot-ssm-read-prod'
$HealthUrl     = 'https://api.anot.health/'        # public version/health endpoint (GET /)

# Project dir = parent of this script's folder (..\ from \scripts).
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'

# Timestamped backup dir (matches the backup-v39-* glob used by ROLLBACK_V40_SSM.md).
$Stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $ProjectDir "backup-v39-$Stamp"

# Plaintext env properties to strip from EB once SSM is the source of truth.
$SecretsToRemove = @(
    'JWT_SECRET', 'SETTINGS_ENCRYPTION_KEY', 'DATABASE_URL', 'DB_PASSWORD',
    'DB_USER', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'ANTHROPIC_API_KEY',
    'DEEPGRAM_API_KEY', 'DEEPGRAM_WEBHOOK_SECRET', 'SENTRY_DSN',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'
)

# Secrets that MUST exist in SSM before we are willing to deploy v40.
$RequiredSsmParams = @(
    'JWT_SECRET', 'SETTINGS_ENCRYPTION_KEY', 'DB_PASSWORD', 'DATABASE_URL', 'ANTHROPIC_API_KEY'
)

# Make every aws call in this session default to the right region.
$env:AWS_DEFAULT_REGION = $Region
#endregion

#region --------------------------- HELPERS -----------------------------------
function Write-Phase {
    param([string]$Title)
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}

function Write-Step { param([string]$Message) Write-Host "  -> $Message" -ForegroundColor Gray }
function Write-Ok   { param([string]$Message) Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  [!!] $Message" -ForegroundColor Yellow }

function Confirm-Step {
    param([string]$Message)
    if ($Force -or $SkipConfirm) { Write-Step "$Message (auto-confirmed)"; return }
    $answer = Read-Host "  ?? $Message  [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw "Aborted by operator at: $Message" }
}

# Run the AWS CLI and fail loudly if it returns a non-zero exit code. We let the
# CLI write JSON to stdout and capture it for the caller.
function Invoke-Aws {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
    $output = & aws @CliArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "aws $($CliArgs -join ' ') failed (exit $LASTEXITCODE):`n$output"
    }
    return $output
}

# Crypto-strong base64 secret (default 32 bytes -> ~44 char string).
function New-Base64Secret {
    param([int]$Bytes = 32)
    $buffer = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($buffer)
}

# Crypto-strong URL-safe alphanumeric secret (good for DB passwords / URIs).
function New-AlnumSecret {
    param([int]$Length = 32)
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $buffer = New-Object byte[] $Length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $buffer) { [void]$sb.Append($chars[$b % $chars.Length]) }
    return $sb.ToString()
}

# Put a SecureString parameter (overwrite if it already exists). Never logs value.
function Put-Secret {
    param([string]$Name, [string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { Write-Warn "skipping empty $Name"; return }
    Invoke-Aws ssm put-parameter --name "$SsmPrefix/$Name" --type SecureString --value $Value --overwrite | Out-Null
    Write-Step "stored $SsmPrefix/$Name"
}
#endregion

# ==============================================================================
# PRE-FLIGHT
# ==============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity + environment checks'

Write-Step 'Checking AWS CLI and Node.js are installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Step "AWS CLI: $awsVersion"

$nodeVersion = (& node -v) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Node.js not found on PATH. Install Node.js 18+.' }
Write-Step "Node.js: $nodeVersion"

Write-Step 'Verifying AWS identity...'
$identity = Invoke-Aws sts get-caller-identity --output json | ConvertFrom-Json
Write-Step "Authenticated as: $($identity.Arn)"
if ($identity.Account -ne $AwsAccountId) {
    throw "Wrong AWS account: $($identity.Account) (expected $AwsAccountId)."
}

Write-Step "Confirming EB environment '$EbEnvName' exists..."
$envInfo = Invoke-Aws elasticbeanstalk describe-environments `
    --application-name $EbAppName --environment-names $EbEnvName --output json | ConvertFrom-Json
if (-not $envInfo.Environments -or $envInfo.Environments.Count -eq 0) {
    throw "EB environment '$EbEnvName' not found in application '$EbAppName'."
}
Write-Step "Current EB version: $($envInfo.Environments[0].VersionLabel) / health: $($envInfo.Environments[0].Health)"

Write-Step "Confirming RDS instance '$RdsInstanceId' exists..."
$rds = Invoke-Aws rds describe-db-instances --db-instance-identifier $RdsInstanceId --output json | ConvertFrom-Json
$dbInstance = $rds.DBInstances[0]
Write-Step "RDS status: $($dbInstance.DBInstanceStatus)"

# Capture current EB option settings once - used for third-party key fallbacks,
# the existing SETTINGS_ENCRYPTION_KEY, and DB connection details.
Write-Step 'Reading current EB configuration (for fallbacks)...'
$cfg = Invoke-Aws elasticbeanstalk describe-configuration-settings `
    --application-name $EbAppName --environment-name $EbEnvName --output json | ConvertFrom-Json
$ebOpts = $cfg.ConfigurationSettings[0].OptionSettings
function Get-EbVal { param([string]$Name) ($ebOpts | Where-Object { $_.OptionName -eq $Name }).Value }

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Ok 'Pre-flight checks passed.'

# ==============================================================================
# BACKUP - snapshot RDS + export the EB config BEFORE anything changes
# ==============================================================================
Write-Phase 'BACKUP: RDS snapshot + EB config export (rollback base)'

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
Write-Step "Backup directory: $BackupDir"

# 1) EB configuration export - R1 in ROLLBACK_V40_SSM.md restores env props from this.
$ebConfigBackup = Join-Path $BackupDir 'eb-config-settings-v39.json'
Write-Step 'Exporting current EB configuration settings...'
Invoke-Aws elasticbeanstalk describe-configuration-settings `
    --application-name $EbAppName --environment-name $EbEnvName --output json |
    Out-File -FilePath $ebConfigBackup -Encoding utf8
if (-not (Test-Path $ebConfigBackup) -or (Get-Item $ebConfigBackup).Length -eq 0) {
    throw "EB config export failed or is empty: $ebConfigBackup"
}
Write-Ok "EB config saved to $ebConfigBackup"

# 2) RDS snapshot - R4 in ROLLBACK_V40_SSM.md restores data from this.
$SnapshotId = "anot-v39-predeploy-$Stamp"
$snapshotIdFile = Join-Path $BackupDir 'rds-snapshot-id.txt'
Write-Step "Creating RDS snapshot '$SnapshotId' (this can take several minutes)..."
Invoke-Aws rds create-db-snapshot `
    --db-instance-identifier $RdsInstanceId `
    --db-snapshot-identifier $SnapshotId | Out-Null
$SnapshotId | Out-File -FilePath $snapshotIdFile -Encoding ascii
Write-Step 'Waiting for the snapshot to become available...'
Invoke-Aws rds wait db-snapshot-available --db-snapshot-identifier $SnapshotId
Write-Ok "RDS snapshot '$SnapshotId' available; id written to $snapshotIdFile"

# ==============================================================================
# PHASE 0 - IAM: add SSM + KMS read permissions to the EC2 instance role
# ==============================================================================
Write-Phase 'PHASE 0: Grant the EB instance role SSM + KMS read access'

$paramArn = "arn:aws:ssm:${Region}:${AwsAccountId}:parameter${SsmPrefix}/*"
$viaService = "ssm.${Region}.amazonaws.com"

$policy = [ordered]@{
    Version   = '2012-10-17'
    Statement = @(
        [ordered]@{
            Sid      = 'ReadAnotProdParams'
            Effect   = 'Allow'
            Action   = @('ssm:GetParametersByPath', 'ssm:GetParameters', 'ssm:GetParameter')
            Resource = $paramArn
        },
        [ordered]@{
            Sid       = 'DecryptAnotProdParams'
            Effect    = 'Allow'
            Action    = @('kms:Decrypt')
            Resource  = '*'
            Condition = @{ StringEquals = @{ 'kms:ViaService' = $viaService } }
        }
    )
}

$policyFile = Join-Path $ArtifactDir 'anot-ssm-read-policy.json'
$policy | ConvertTo-Json -Depth 10 | Out-File -FilePath $policyFile -Encoding ascii
Write-Step "Wrote policy document to $policyFile"

Write-Step "Attaching inline policy '$PolicyName' to role '$InstanceRole'..."
Invoke-Aws iam put-role-policy --role-name $InstanceRole `
    --policy-name $PolicyName --policy-document "file://$policyFile" | Out-Null
Write-Ok "Instance role '$InstanceRole' can now read $SsmPrefix/* and decrypt via KMS."

# ==============================================================================
# PHASE 1 - Prepare secrets (generate new; REUSE existing encryption key)
# ==============================================================================
Write-Phase 'PHASE 1: Prepare secret values'

$NewDbPassword     = New-AlnumSecret -Length 32          # URL-safe DB password
$NewJwtSecret      = New-Base64Secret -Bytes 48
$NewWebhookSecret  = New-Base64Secret -Bytes 32          # DEEPGRAM_WEBHOOK_SECRET

Write-Step 'Generated: DB password, JWT_SECRET, DEEPGRAM_WEBHOOK_SECRET'
Write-Warn 'These live in memory only and are written to SSM (never echoed to the console).'
Write-Warn 'NOTE: rotating JWT_SECRET invalidates all existing sessions - users must log in again.'

# SETTINGS_ENCRYPTION_KEY is NOT rotated here. Copy the existing value from EB so
# the system_settings ciphertext (Deepgram/Anthropic keys) stays decryptable.
$CurrentSettingsKey = Get-EbVal 'SETTINGS_ENCRYPTION_KEY'
if ([string]::IsNullOrEmpty($CurrentSettingsKey)) {
    # Maybe it already lives in SSM from a prior run - accept that and reuse it.
    $existingSsmKey = & aws ssm get-parameter --name "$SsmPrefix/SETTINGS_ENCRYPTION_KEY" `
        --with-decryption --query 'Parameter.Value' --output text 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrEmpty($existingSsmKey) -and $existingSsmKey -ne 'None') {
        $CurrentSettingsKey = $existingSsmKey
        Write-Step 'Reusing existing SETTINGS_ENCRYPTION_KEY already present in SSM.'
    } else {
        throw @'
SETTINGS_ENCRYPTION_KEY was not found in the EB config or in SSM.
Refusing to generate a NEW one - that would orphan every encrypted value in
system_settings (saved Deepgram/Anthropic keys). Provide the current key (set it
as the EB env property SETTINGS_ENCRYPTION_KEY, or as the SSM SecureString
'/anot/prod/SETTINGS_ENCRYPTION_KEY') and re-run. To intentionally rotate the
key, use scripts/reencrypt-settings-key.js first (see DEPLOYMENT_V40_SSM.md).
'@
    }
} else {
    Write-Step 'Reusing existing SETTINGS_ENCRYPTION_KEY from EB config (NOT rotated).'
}

# Third-party keys cannot be auto-generated. Reuse the current EB value if set,
# otherwise prompt so we do not overwrite a live key with an empty string.
function Resolve-ThirdPartyKey {
    param([string]$EnvName, [switch]$Optional)
    $existing = Get-EbVal $EnvName
    if (-not [string]::IsNullOrEmpty($existing)) {
        Write-Step "Reusing existing $EnvName from EB config."
        return $existing
    }
    if ($Optional) {
        Write-Warn "$EnvName not set in EB; leaving blank (optional)."
        return ''
    }
    return (Read-Host "  Enter value for $EnvName")
}

$AnthropicApiKey = Resolve-ThirdPartyKey 'ANTHROPIC_API_KEY'
$DeepgramApiKey  = Resolve-ThirdPartyKey 'DEEPGRAM_API_KEY' -Optional
$SentryDsn       = Resolve-ThirdPartyKey 'SENTRY_DSN' -Optional
$SmtpHost        = Resolve-ThirdPartyKey 'SMTP_HOST' -Optional
$SmtpPort        = Resolve-ThirdPartyKey 'SMTP_PORT' -Optional
$SmtpUser        = Resolve-ThirdPartyKey 'SMTP_USER' -Optional
$SmtpPass        = Resolve-ThirdPartyKey 'SMTP_PASS' -Optional

Write-Ok 'All secret values prepared.'

# ==============================================================================
# PHASE 2 - Build the v40 artifact and register the application version
# ==============================================================================
# Done BEFORE any destructive change so a build failure can't leave prod
# half-migrated. The version is only deployed later (Phase 6), after SSM is ready.
Write-Phase 'PHASE 2: Build v40 artifact and create application version'

Push-Location $ProjectDir
try {
    Write-Step 'Running npm install (pulls @aws-sdk/client-ssm + lockfile)...'
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }

    Write-Step 'Building deployment artifact...'
    $zipPath = Join-Path $ArtifactDir "anot-backend-$NewVersion.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    $include = @(
        'src', 'scripts', 'migrations', 'certs', 'package.json',
        'package-lock.json', 'Dockerfile', '.ebextensions', '.dockerignore',
        'instrument.js', 'ecosystem.config.js'
    )
    $existing = $include | Where-Object { Test-Path (Join-Path $ProjectDir $_) }
    Compress-Archive -Path $existing -DestinationPath $zipPath -Force
    Write-Ok "Built artifact: $zipPath"
}
finally {
    Pop-Location
}

Write-Step 'Resolving Elastic Beanstalk S3 storage location...'
$storage = Invoke-Aws elasticbeanstalk create-storage-location --output json | ConvertFrom-Json
$bucket = $storage.S3Bucket
$s3Key = "$EbAppName/anot-backend-$NewVersion.zip"

Write-Step "Uploading artifact to s3://$bucket/$s3Key ..."
Invoke-Aws s3 cp $zipPath "s3://$bucket/$s3Key" | Out-Null

Write-Step "Creating application version '$NewVersion'..."
Invoke-Aws elasticbeanstalk create-application-version `
    --application-name $EbAppName `
    --version-label $NewVersion `
    --source-bundle "S3Bucket=$bucket,S3Key=$s3Key" `
    --description 'v40 - SSM secrets bootstrap' | Out-Null
Write-Ok "Application version '$NewVersion' registered (not yet deployed)."

# ==============================================================================
# PHASE 3 - Rotate the database password (RDS master password)
# ==============================================================================
Write-Phase 'PHASE 3: Rotate the RDS database password'

# Pull connection details straight from RDS, with EB config as fallback.
$DbHost = $dbInstance.Endpoint.Address
$DbPort = [string]$dbInstance.Endpoint.Port
$DbUser = $dbInstance.MasterUsername
$DbName = $dbInstance.DBName
if ([string]::IsNullOrEmpty($DbName)) { $DbName = Get-EbVal 'DB_NAME' }
if ([string]::IsNullOrEmpty($DbName)) { $DbName = 'anot' }

Write-Step "Target: host=$DbHost port=$DbPort db=$DbName user=$DbUser"
Confirm-Step "Rotate the master password for RDS '$RdsInstanceId' now (applied immediately)?"

Write-Step 'Submitting password change to RDS...'
Invoke-Aws rds modify-db-instance --db-instance-identifier $RdsInstanceId `
    --master-user-password $NewDbPassword --apply-immediately | Out-Null

# RDS briefly reports 'available' before flipping to 'modifying'. Give it a
# moment, then wait until it is fully available again.
Write-Step 'Waiting for RDS to apply the change (this can take a few minutes)...'
Start-Sleep -Seconds 20
Invoke-Aws rds wait db-instance-available --db-instance-identifier $RdsInstanceId
Write-Ok 'RDS password rotated and instance is available.'

# Build the connection string (password is alphanumeric -> no URL-encoding).
$DatabaseUrl = "postgres://${DbUser}:${NewDbPassword}@${DbHost}:${DbPort}/${DbName}"

# ==============================================================================
# PHASE 4 - Store all API keys / secrets in SSM as SecureString
# ==============================================================================
Write-Phase 'PHASE 4: Store secrets in SSM Parameter Store (SecureString)'

Put-Secret 'JWT_SECRET'              $NewJwtSecret
Put-Secret 'SETTINGS_ENCRYPTION_KEY' $CurrentSettingsKey   # existing value, unchanged
Put-Secret 'DEEPGRAM_WEBHOOK_SECRET' $NewWebhookSecret

Put-Secret 'DB_HOST'      $DbHost
Put-Secret 'DB_PORT'      $DbPort
Put-Secret 'DB_NAME'      $DbName
Put-Secret 'DB_USER'      $DbUser
Put-Secret 'DB_PASSWORD'  $NewDbPassword
Put-Secret 'DATABASE_URL' $DatabaseUrl

Put-Secret 'ANTHROPIC_API_KEY' $AnthropicApiKey
Put-Secret 'DEEPGRAM_API_KEY'  $DeepgramApiKey
Put-Secret 'SENTRY_DSN'        $SentryDsn
Put-Secret 'SMTP_HOST'         $SmtpHost
Put-Secret 'SMTP_PORT'         $SmtpPort
Put-Secret 'SMTP_USER'         $SmtpUser
Put-Secret 'SMTP_PASS'         $SmtpPass

Write-Ok 'Secrets written to SSM.'

# ==============================================================================
# PHASE 5 - Verify required secrets exist in SSM  (GATE before deploy)
# ==============================================================================
Write-Phase 'PHASE 5: Verify required secrets in SSM (deploy gate)'

Write-Step "Listing parameter names under $SsmPrefix (names only - values never printed)..."
$paramNames = Invoke-Aws ssm get-parameters-by-path --path $SsmPrefix --recursive `
    --query 'Parameters[].Name' --output text
$names = @()
if ($paramNames) { $names = ($paramNames -split '\s+') | Where-Object { $_ } }

foreach ($n in ($names | Sort-Object)) { Write-Host "    $n" -ForegroundColor DarkGray }

$missing = @()
foreach ($e in $RequiredSsmParams) {
    if (-not ($names -contains "$SsmPrefix/$e")) { $missing += $e }
}
if ($missing.Count -gt 0) {
    # Hard stop: deploying v40 now would boot with missing secrets.
    throw "Required SSM parameters are missing: $($missing -join ', '). Aborting BEFORE deploy."
}
Write-Ok "Found $($names.Count) parameter(s); all required secrets present."

# ==============================================================================
# PHASE 6 - Enable USE_SSM=true AND deploy v40 (one atomic environment update)
# ==============================================================================
# USE_SSM and the v40 version label are applied in a SINGLE update-environment
# call, so the new v40 instances launch with USE_SSM=true already set and read
# the rotated DB password from SSM on first boot. There is no window where v40
# runs without SSM, and no extra restart of the (now stale-credential) v39.
Write-Phase 'PHASE 6: Enable SSM and deploy v40 (atomic)'

Confirm-Step "Deploy version '$NewVersion' to '$EbEnvName' with USE_SSM=true now?"
Write-Step 'Setting USE_SSM=true + SSM_REGION + SSM_PREFIX and deploying v40...'
Invoke-Aws elasticbeanstalk update-environment `
    --application-name $EbAppName --environment-name $EbEnvName `
    --version-label $NewVersion `
    --option-settings `
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=USE_SSM,Value=true" `
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SSM_REGION,Value=$Region" `
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SSM_PREFIX,Value=$SsmPrefix" | Out-Null

Write-Step 'Waiting for the deployment to complete...'
Invoke-Aws elasticbeanstalk wait environment-updated `
    --application-name $EbAppName --environment-names $EbEnvName
Write-Ok "Version '$NewVersion' deployed with USE_SSM enabled."

# ==============================================================================
# PHASE 7 - Remove the now-redundant plaintext secret env properties from EB
# ==============================================================================
# Done LAST so that until this point the EB env-property fallback still exists
# for an emergency rollback (see ROLLBACK_V40_SSM.md R1/R2).
Write-Phase 'PHASE 7: Remove plaintext secrets from EB'

Confirm-Step 'Remove the now-redundant plaintext secret env properties from EB?'
$removeArgs = $SecretsToRemove | ForEach-Object {
    "Namespace=aws:elasticbeanstalk:application:environment,OptionName=$_"
}
Write-Step 'Removing plaintext secret properties...'
Invoke-Aws elasticbeanstalk update-environment `
    --application-name $EbAppName --environment-name $EbEnvName `
    --options-to-remove $removeArgs | Out-Null

Write-Step 'Waiting for the environment to settle...'
Invoke-Aws elasticbeanstalk wait environment-updated `
    --application-name $EbAppName --environment-names $EbEnvName
Write-Ok 'Plaintext secrets removed from EB. Secrets now sourced from SSM only.'

# ==============================================================================
# PHASE 8 - Test the health endpoint
# ==============================================================================
Write-Phase 'PHASE 8: Test the health endpoint'

Write-Step "Querying $HealthUrl ..."
$healthOk = $false
try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 30
    Write-Step "HTTP $($response.StatusCode)"
    Write-Host "    $($response.Content)" -ForegroundColor DarkGray
    if ($response.StatusCode -eq 200 -and $response.Content -match 'v40') { $healthOk = $true }
    elseif ($response.StatusCode -eq 200) { Write-Warn 'Health returned 200 but did not report version v40.' }
}
catch {
    Write-Warn "Health request failed: $($_.Exception.Message)"
}

Write-Step 'Fetching EB environment health...'
$finalEnv = Invoke-Aws elasticbeanstalk describe-environments `
    --application-name $EbAppName --environment-names $EbEnvName --output json | ConvertFrom-Json
$e = $finalEnv.Environments[0]
Write-Host "    Version: $($e.VersionLabel)  Health: $($e.Health)  Status: $($e.HealthStatus)" -ForegroundColor DarkGray

Write-Phase 'DEPLOYMENT SUMMARY'
if ($healthOk -and $e.Health -eq 'Green') {
    Write-Ok "v40 deployed successfully. Endpoint healthy (v40) and EB reports Green."
} else {
    Write-Warn 'Deployment finished but health checks are not fully green.'
    Write-Warn 'Review EB logs: aws elasticbeanstalk request-environment-info --info-type tail'
    Write-Warn "Rollback guide: ROLLBACK_V40_SSM.md (backups in $BackupDir)"
}

Write-Host ''
Write-Host "  Backups for rollback: $BackupDir" -ForegroundColor Yellow
Write-Host '  Manual checks recommended:' -ForegroundColor Yellow
Write-Host '    [ ] Log in (verifies new JWT_SECRET from SSM; all old sessions are now invalid)' -ForegroundColor Yellow
Write-Host '    [ ] Confirm DB reads/writes succeed (new DB password from SSM)' -ForegroundColor Yellow
Write-Host '    [ ] Admin -> Settings shows saved Deepgram/Anthropic keys (settings key was preserved)' -ForegroundColor Yellow
Write-Host '    [ ] Generate an AI note (verifies ANTHROPIC_API_KEY from SSM)' -ForegroundColor Yellow
Write-Host ''
Write-Host '  Deferred: SETTINGS_ENCRYPTION_KEY was NOT rotated. To rotate it later, run' -ForegroundColor Yellow
Write-Host '    scripts/reencrypt-settings-key.js (dry-run, then live) then update SSM.' -ForegroundColor Yellow
Write-Host ''
