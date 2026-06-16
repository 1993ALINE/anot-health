<#
================================================================================
 deploy-v40-ssm.ps1  -  Anot Health v40 deployment with SSM secrets rotation
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHAT IT DOES (7 phases, run top to bottom):
   Phase 0  Add SSM + KMS read permissions to the EC2 instance role
   Phase 1  Generate new secrets (DB password, JWT, encryption + webhook keys)
   Phase 2  Rotate the database password (RDS master password + SSM)
   Phase 3  Store all API keys / secrets in SSM as SecureString
   Phase 4  Build and deploy v40 (npm install + zip + Elastic Beanstalk)
   Phase 5  Update the EB environment (USE_SSM=true, drop plaintext secrets)
   Phase 6  Verify the secrets are stored in SSM
   Phase 7  Test the health endpoint

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
$HealthUrl     = 'https://api.anot.health/health'  # public health endpoint

# Project dir = parent of this script's folder (..\ from \scripts).
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $ProjectDir 'dist'

# Plaintext env properties to strip from EB once SSM is the source of truth.
$SecretsToRemove = @(
    'JWT_SECRET', 'SETTINGS_ENCRYPTION_KEY', 'DATABASE_URL', 'DB_PASSWORD',
    'DB_USER', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'ANTHROPIC_API_KEY',
    'DEEPGRAM_API_KEY', 'DEEPGRAM_WEBHOOK_SECRET', 'SENTRY_DSN',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'
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

# Capture current EB option settings once - used for third-party key fallbacks
# and DB connection details.
Write-Step 'Reading current EB configuration (for fallbacks)...'
$cfg = Invoke-Aws elasticbeanstalk describe-configuration-settings `
    --application-name $EbAppName --environment-name $EbEnvName --output json | ConvertFrom-Json
$ebOpts = $cfg.ConfigurationSettings[0].OptionSettings
function Get-EbVal { param([string]$Name) ($ebOpts | Where-Object { $_.OptionName -eq $Name }).Value }

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Write-Ok 'Pre-flight checks passed.'

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
# PHASE 1 - Generate new secrets (DB password, JWT, encryption + webhook keys)
# ==============================================================================
Write-Phase 'PHASE 1: Generate new secrets'

$NewDbPassword     = New-AlnumSecret -Length 32          # URL-safe DB password
$NewJwtSecret      = New-Base64Secret -Bytes 48
$NewSettingsKey    = New-Base64Secret -Bytes 32          # SETTINGS_ENCRYPTION_KEY
$NewWebhookSecret  = New-Base64Secret -Bytes 32          # DEEPGRAM_WEBHOOK_SECRET

Write-Step 'Generated: DB password, JWT_SECRET, SETTINGS_ENCRYPTION_KEY, DEEPGRAM_WEBHOOK_SECRET'
Write-Warn 'These live in memory only and are written to SSM (never echoed to the console).'

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
# PHASE 2 - Rotate the database password (RDS master password + SSM)
# ==============================================================================
Write-Phase 'PHASE 2: Rotate the RDS database password'

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
# PHASE 3 - Store all API keys / secrets in SSM as SecureString
# ==============================================================================
Write-Phase 'PHASE 3: Store secrets in SSM Parameter Store (SecureString)'

Put-Secret 'JWT_SECRET'              $NewJwtSecret
Put-Secret 'SETTINGS_ENCRYPTION_KEY' $NewSettingsKey
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
# PHASE 4 - Build and deploy v40 (npm install + zip + Elastic Beanstalk)
# ==============================================================================
Write-Phase 'PHASE 4: Build and deploy v40'

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
    --description 'v40 - SSM secrets rotation' | Out-Null

Confirm-Step "Deploy version '$NewVersion' to '$EbEnvName' now?"
Write-Step 'Triggering deployment...'
Invoke-Aws elasticbeanstalk update-environment `
    --application-name $EbAppName --environment-name $EbEnvName `
    --version-label $NewVersion | Out-Null

Write-Step 'Waiting for the deployment to complete...'
Invoke-Aws elasticbeanstalk wait environment-updated `
    --application-name $EbAppName --environment-names $EbEnvName
Write-Ok "Version '$NewVersion' deployed."

# ==============================================================================
# PHASE 5 - Update EB environment (USE_SSM=true, remove plaintext secrets)
# ==============================================================================
Write-Phase 'PHASE 5: Enable SSM and remove plaintext secrets on EB'

Write-Step 'Setting USE_SSM=true, SSM_REGION and SSM_PREFIX...'
Invoke-Aws elasticbeanstalk update-environment `
    --application-name $EbAppName --environment-name $EbEnvName `
    --option-settings `
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=USE_SSM,Value=true" `
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SSM_REGION,Value=$Region" `
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SSM_PREFIX,Value=$SsmPrefix" | Out-Null

Write-Step 'Waiting for the environment update to complete...'
Invoke-Aws elasticbeanstalk wait environment-updated `
    --application-name $EbAppName --environment-names $EbEnvName
Write-Ok 'USE_SSM enabled.'

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
# PHASE 6 - Verify the secrets are stored in SSM
# ==============================================================================
Write-Phase 'PHASE 6: Verify secrets in SSM'

Write-Step "Listing parameter names under $SsmPrefix (names only - values never printed)..."
$paramNames = Invoke-Aws ssm get-parameters-by-path --path $SsmPrefix --recursive `
    --query 'Parameters[].Name' --output text
$names = @()
if ($paramNames) { $names = ($paramNames -split '\s+') | Where-Object { $_ } }

foreach ($n in ($names | Sort-Object)) { Write-Host "    $n" -ForegroundColor DarkGray }

$expected = @('JWT_SECRET', 'SETTINGS_ENCRYPTION_KEY', 'DB_PASSWORD', 'DATABASE_URL', 'ANTHROPIC_API_KEY')
$missing = @()
foreach ($e in $expected) {
    if (-not ($names -contains "$SsmPrefix/$e")) { $missing += $e }
}
if ($missing.Count -gt 0) {
    Write-Warn "Expected parameters missing from SSM: $($missing -join ', ')"
} else {
    Write-Ok "Found $($names.Count) parameter(s); all required secrets present."
}

# ==============================================================================
# PHASE 7 - Test the health endpoint
# ==============================================================================
Write-Phase 'PHASE 7: Test the health endpoint'

Write-Step "Querying $HealthUrl ..."
$healthOk = $false
try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 30
    Write-Step "HTTP $($response.StatusCode)"
    Write-Host "    $($response.Content)" -ForegroundColor DarkGray
    if ($response.StatusCode -eq 200) { $healthOk = $true }
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
    Write-Ok "v40 deployed successfully. Endpoint healthy and EB reports Green."
} else {
    Write-Warn 'Deployment finished but health checks are not fully green.'
    Write-Warn 'Review EB logs: aws elasticbeanstalk request-environment-info --info-type tail'
}

Write-Host ''
Write-Host '  Manual checks recommended:' -ForegroundColor Yellow
Write-Host '    [ ] Log in (verifies new JWT_SECRET from SSM)' -ForegroundColor Yellow
Write-Host '    [ ] Confirm DB reads/writes succeed (new DB password from SSM)' -ForegroundColor Yellow
Write-Host '    [ ] Generate an AI note (verifies ANTHROPIC_API_KEY from SSM)' -ForegroundColor Yellow
Write-Host ''
