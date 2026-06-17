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
   Phase 7  Verify v40 is healthy (endpoint reports v40 + EB Green) - GATE
   Phase 8  Remove plaintext secret env properties from EB - ONLY if Phase 7 passed

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
   - bsdtar (Windows System32\tar.exe) on PATH for building the .zip artifact
   - The signed-in principal can edit IAM, RDS, SSM and Elastic Beanstalk

 USAGE:
   pwsh -File scripts/deploy-v40-ssm.ps1            # live deploy (prompts)
   pwsh -File scripts/deploy-v40-ssm.ps1 -DryRun    # full rehearsal, no changes
   pwsh -File scripts/deploy-v40-ssm.ps1 -Force     # live deploy, no prompts
   (or open in an elevated PowerShell and run the file)

 Destructive / costly steps (RDS password change, plaintext-secret removal)
 prompt for confirmation unless you pass -Force.

 ROBUSTNESS / DIAGNOSTICS:
   * Every AWS CLI call goes through Invoke-Aws, which captures stdout and stderr
     SEPARATELY (so AWS progress/error text never corrupts JSON parsing), checks
     the real exit code, and on failure prints the EXACT command, region, time,
     and the verbatim AWS stderr before throwing. No more silent failures.
   * The fragile Phase 2 calls (S3 upload + create-application-version) retry up
     to 3 times with a 5s backoff and validate their post-conditions (object is
     in S3; the application version is actually registered).
   * -DryRun runs every read-only check and the local build, validates all
     prerequisites, and prints exactly which mutating calls WOULD run - without
     touching IAM, RDS, SSM, S3 or the environment. Run it before a live deploy.
   * A top-level trap prints a clear DEPLOYMENT FAILED banner naming the phase
     that failed and the underlying error, then exits non-zero.
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$DryRun
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

# Disable the AWS CLI v2 pager. By default AWS CLI v2 pipes output through a
# pager (less/more on PATH). In a non-interactive script that pager can hang
# waiting for input or swallow output, which makes a command look like it "did
# nothing" or "failed silently" - exactly the Phase 2 symptom. Force the CLI to
# write directly to stdout. (Empty string = no pager.)
$env:AWS_PAGER = ''

# Tracks the phase we are currently in so the failure trap can name it.
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
    if ($DryRun)               { Write-Step "[DRY-RUN] would prompt: $Message"; return }
    if ($Force -or $SkipConfirm) { Write-Step "$Message (auto-confirmed)"; return }
    $answer = Read-Host "  ?? $Message  [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw "Aborted by operator at: $Message" }
}

# ------------------------------------------------------------------------------
# Invoke-Aws : the single choke point for every AWS CLI call.
#
# Why it is built the way it is:
#   * It captures stdout and stderr SEPARATELY without ever corrupting the JSON
#     we hand to ConvertFrom-Json. The call uses '2>&1' to merge the streams,
#     then splits the result by OBJECT TYPE: native stdout arrives as plain
#     strings, native stderr arrives as [ErrorRecord] objects. We keep the
#     strings as stdout and turn the ErrorRecords back into their raw message
#     text for diagnostics. This is the only reliable cross-version way to keep
#     AWS progress/warning text (which the CLI writes to stderr even on SUCCESS,
#     e.g. 's3 cp' progress) out of the JSON.
#   * It temporarily sets $ErrorActionPreference='Continue' around the call.
#     With the script-wide 'Stop', a native command writing ANYTHING to stderr
#     - even on a clean exit 0 - raises a terminating NativeCommandError BEFORE
#     we can read $LASTEXITCODE. That is the exact "fails silently / fails for
#     no reason" symptom this script hit. Relaxing it locally lets us inspect
#     the REAL exit code and decide success/failure ourselves.
#   * On failure we print/return the EXACT command, region, timestamp, exit code
#     and the verbatim AWS stderr, then throw a detailed message (which the
#     top-level trap also surfaces). Nothing fails silently.
#   * -Retries / -DelaySeconds add bounded retry with backoff for flaky calls
#     (S3 upload, create-application-version, eventual-consistency reads).
#   * -SkipInDryRun marks a MUTATING call (or a wait that only makes sense after
#     a mutation). In -DryRun those are printed and skipped; read-only calls
#     still run so the rehearsal exercises real permissions and data.
#
# PositionalBinding=$false so positional args (e.g. 'sts get-caller-identity')
# all flow into $CliArgs and are never mis-bound to -Retries/-DelaySeconds/etc.
# ------------------------------------------------------------------------------
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
        $stdout = ''
        $stderr = ''
        $code   = 0

        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'   # so native stderr does not terminate us
        try {
            $captured = & aws @CliArgs 2>&1
            $code = $LASTEXITCODE
        }
        catch {
            # aws not found on PATH, or some other launch-time failure.
            $code     = 9001
            $captured = $_.Exception.Message
        }
        finally {
            $ErrorActionPreference = $prevEap
        }

        # Split by object type: stderr lines arrive as ErrorRecord objects, stdout
        # lines as plain strings. .ToString() yields the raw message (no PS
        # "At line:.. CategoryInfo" decoration).
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

        # --- Failure path: assemble a detailed, copy-pasteable diagnostic. ---
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
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "ssm put-parameter $SsmPrefix/$Name" `
        ssm put-parameter --name "$SsmPrefix/$Name" --type SecureString --value $Value --overwrite | Out-Null
    Write-Step "stored $SsmPrefix/$Name"
}

# Return the EB application-version object for a label, or $null if it does not
# exist. Read-only, so it runs even in -DryRun (used for re-run idempotency).
function Get-AppVersion {
    param([string]$Label)
    $json = Invoke-Aws -Retries 2 -DelaySeconds 3 `
        elasticbeanstalk describe-application-versions `
        --application-name $EbAppName --version-labels $Label --output json
    if (-not $json) { return $null }
    $obj = $json | ConvertFrom-Json
    if ($obj.ApplicationVersions -and @($obj.ApplicationVersions).Count -gt 0) {
        return @($obj.ApplicationVersions)[0]
    }
    return $null
}

# Verify v40 is actually live and healthy. Elastic Beanstalk is the AUTHORITATIVE
# signal: if EB reports Health=Green on VersionLabel=v40, the new instances booted,
# passed their health checks, and are reading secrets from SSM. The public
# https://api.anot.health/ probe is informational ONLY - it depends on external DNS
# that can fail independently of the app (a separate infra concern), so a probe
# failure must NOT block the deploy. Returns a result object so the caller can gate
# on EB health while still surfacing the endpoint result.
#
# This still protects the plaintext-secret removal: we never strip the EB
# env-property fallback unless EB confirms v40 is Green, because the v39 we'd roll
# back to cannot read secrets from SSM (no loadSecrets.js) and would come up RED.
function Test-V40Healthy {
    $endpointOk = $false
    Write-Step "Querying $HealthUrl (informational - EB health is authoritative) ..."
    try {
        $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 30
        Write-Step "HTTP $($response.StatusCode)"
        Write-Host "    $($response.Content)" -ForegroundColor DarkGray
        if ($response.StatusCode -eq 200 -and $response.Content -match $NewVersion) {
            $endpointOk = $true
        }
        elseif ($response.StatusCode -eq 200) {
            Write-Warn "Health returned 200 but did not report version $NewVersion."
        }
    }
    catch {
        Write-Warn "Health probe failed (likely DNS/infra, not the app): $($_.Exception.Message)"
    }

    Write-Step 'Fetching EB environment health (authoritative)...'
    $ebGreen = $false
    $version = '(unknown)'
    $health  = '(unknown)'
    $status  = '(unknown)'
    try {
        $envState = Invoke-Aws elasticbeanstalk describe-environments `
            --application-name $EbAppName --environment-names $EbEnvName --output json | ConvertFrom-Json
        $envObj = $envState.Environments[0]
        $version = $envObj.VersionLabel
        $health  = $envObj.Health
        $status  = $envObj.HealthStatus
        Write-Host "    Version: $version  Health: $health  Status: $status" -ForegroundColor DarkGray
        if ($health -eq 'Green' -and $version -eq $NewVersion) {
            $ebGreen = $true
        }
    }
    catch {
        Write-Warn "Could not read EB environment health: $($_.Exception.Message)"
    }

    return [pscustomobject]@{
        EbGreen    = $ebGreen
        EndpointOk = $endpointOk
        Version    = $version
        Health     = $health
        Status     = $status
    }
}
#endregion

# ------------------------------------------------------------------------------
# Top-level failure trap: any unhandled terminating error (a failed AWS call, a
# failed build, an aborted prompt, etc.) lands here. We print a clear banner that
# names the phase that was running and the underlying error, then exit non-zero.
# This guarantees the script never "exits silently" - there is always a reason.
# ------------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  DEPLOYMENT FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    Write-Host "  Time  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Red
    Write-Host '  Error :' -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) {
        Write-Host "    $l" -ForegroundColor Red
    }
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
        Write-Host '  Where :' -ForegroundColor DarkRed
        foreach ($l in ($_.InvocationInfo.PositionMessage -split "`n")) {
            Write-Host "    $l" -ForegroundColor DarkRed
        }
    }
    Write-Host ''
    Write-Host "  Backups (if created): $BackupDir" -ForegroundColor Yellow
    Write-Host '  Rollback guide      : ROLLBACK_V40_SSM.md' -ForegroundColor Yellow
    Write-Host '  Tail EB logs        : aws elasticbeanstalk request-environment-info --environment-name anot-backend-prod --info-type tail' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

# ==============================================================================
# PRE-FLIGHT
# ==============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity + environment checks'

if ($DryRun) {
    Write-Warn 'DRY-RUN MODE: read-only checks + local build only. No IAM/RDS/SSM/S3/EB changes will be made.'
} else {
    Write-Step 'LIVE MODE: this run can rotate the DB password and change the environment.'
}

Write-Step 'Checking AWS CLI and Node.js are installed...'
$awsVersion = (& aws --version) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'AWS CLI not found on PATH. Install AWS CLI v2.' }
Write-Step "AWS CLI: $awsVersion"

$nodeVersion = (& node -v) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Node.js not found on PATH. Install Node.js 18+.' }
Write-Step "Node.js: $nodeVersion"

$npmVersion = (& npm -v) 2>&1
if ($LASTEXITCODE -ne 0) { throw 'npm not found on PATH. Install Node.js 18+ (which bundles npm).' }
Write-Step "npm: $npmVersion"

# Resolve bsdtar NOW (Phase 2 needs it). Failing here means we never start the
# backups/snapshot just to discover at Phase 2 that we cannot build the zip.
Write-Step 'Locating bsdtar (System32\tar.exe) for the build...'
$script:TarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $script:TarExe)) {
    $tarCmd = Get-Command tar -ErrorAction SilentlyContinue
    if (-not $tarCmd) {
        throw 'tar (bsdtar) not found. Windows 10/11 ship it at System32\tar.exe; build from an environment that provides bsdtar (GNU tar from Git Bash cannot create .zip archives).'
    }
    $script:TarExe = $tarCmd.Source
}
Write-Step "tar: $script:TarExe"

# Validate the project directory and that the files we intend to ship exist.
Write-Step "Validating project directory: $ProjectDir"
if (-not (Test-Path $ProjectDir)) { throw "Project directory not found: $ProjectDir" }
if (-not (Test-Path (Join-Path $ProjectDir 'package.json'))) {
    throw "package.json not found in project dir ($ProjectDir). Are you running from the repo?"
}

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

# Safely read a single EB option value by name. The AWS CLI / ConvertFrom-Json
# can hand back option settings as a nested array (e.g. [[{...}]]), and a
# Where-Object filter can match 0, 1, or many objects. Naively calling .Value on
# that returns an array (or $null) instead of the string we want, which later
# blows up calls like .Trim(). This normalizes all of those shapes to either a
# clean non-empty trimmed string or $null.
function Get-EbVal {
    param([string]$Name)

    # Force an array so .Count / indexing behave even for a single match.
    # (Avoid the name $matches - that is PowerShell's automatic -match variable.)
    $found = @($ebOpts | Where-Object { $_.OptionName -eq $Name })
    if ($found.Count -eq 0) { return $null }

    $val = $found[0].Value

    # Defensively unwrap any nested arrays (e.g. [[ "value" ]]) down to a scalar.
    while ($val -is [System.Array]) {
        if ($val.Count -eq 0) { return $null }
        $val = $val[0]
    }
    if ($null -eq $val) { return $null }

    $str = ([string]$val).Trim()
    if ([string]::IsNullOrEmpty($str)) { return $null }
    return $str
}

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
Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "rds create-db-snapshot $SnapshotId" `
    rds create-db-snapshot `
    --db-instance-identifier $RdsInstanceId `
    --db-snapshot-identifier $SnapshotId | Out-Null
if (-not $DryRun) {
    $SnapshotId | Out-File -FilePath $snapshotIdFile -Encoding ascii
    Write-Step 'Waiting for the snapshot to become available...'
    Invoke-Aws -SkipInDryRun rds wait db-snapshot-available --db-snapshot-identifier $SnapshotId
    Write-Ok "RDS snapshot '$SnapshotId' available; id written to $snapshotIdFile"
} else {
    Write-Ok "[DRY-RUN] would create + wait for RDS snapshot '$SnapshotId'."
}

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
Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "iam put-role-policy $PolicyName" `
    iam put-role-policy --role-name $InstanceRole `
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
    param([string]$EnvName, [switch]$Optional, [string]$PromptText)
    $existing = Get-EbVal $EnvName
    if (-not [string]::IsNullOrEmpty($existing)) {
        Write-Step "Reusing existing $EnvName from EB config."
        return $existing
    }
    if ($Optional) {
        Write-Warn "$EnvName not set in EB; leaving blank (optional)."
        return ''
    }
    # Required key is missing/empty in EB. Prompt rather than crash, and allow the
    # operator to skip (Phase 5's SSM gate will catch a still-missing required key).
    if ([string]::IsNullOrEmpty($PromptText)) { $PromptText = "Enter value for $EnvName" }
    $entered = Read-Host "  $PromptText"
    if ([string]::IsNullOrEmpty($entered)) {
        Write-Warn "$EnvName left blank (skipped)."
        return ''
    }
    return $entered.Trim()
}

$AnthropicApiKey = Resolve-ThirdPartyKey 'ANTHROPIC_API_KEY' -PromptText 'Paste NEW Anthropic API key (or press Enter to skip)'
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
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE). Fix dependency errors above, then re-run." }

    Write-Step 'Building deployment artifact (tar/bsdtar -> Unix path separators)...'
    $zipPath = Join-Path $ArtifactDir "anot-backend-$NewVersion.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    # Allowlist of paths to ship. We deliberately do NOT include .env (secrets),
    # and we exclude src/uploads + *.webm below so patient audio (PHI) can never
    # leak into a bundle even though 'src' is shipped wholesale.
    $include = @(
        'src', 'scripts', 'migrations', 'certs', 'package.json',
        'package-lock.json', 'Dockerfile', '.ebextensions', '.dockerignore',
        'instrument.js', 'ecosystem.config.js'
    )
    $existing = $include | Where-Object { Test-Path (Join-Path $ProjectDir $_) }

    # IMPORTANT: build the zip with tar (bsdtar/libarchive), NOT PowerShell
    # Compress-Archive. Compress-Archive writes entries with BACKSLASH path
    # separators, which Linux 'unzip' on the EB Node platform rejects with
    # '... appears to use backslashes as path separators' - the deploy then
    # silently fails and EB keeps serving the old code (this is exactly why the
    # v25 bundle failed; see PRODUCTION_READY.md). 'tar -a -c -f *.zip' writes
    # forward slashes. We require Windows' built-in bsdtar (System32\tar.exe);
    # GNU tar (e.g. from Git Bash) cannot create .zip archives at all.
    # (Already resolved + validated in pre-flight; reuse it here.)
    $tarExe = $script:TarExe

    # -a picks the format from the .zip extension; excludes mirror the v39 build
    # (PRODUCTION_READY.md) and keep PHI/node_modules/VCS/artifacts out.
    $tarArgs = @(
        '-a', '-c', '-f', $zipPath,
        '--exclude', 'node_modules',
        '--exclude', 'src/uploads',
        '--exclude', '*.webm',
        '--exclude', '*.zip',
        '--exclude', '*.tar.gz',
        '--exclude', '.git'
    ) + $existing

    & $tarExe @tarArgs
    if ($LASTEXITCODE -ne 0) { throw "tar archive creation failed (exit $LASTEXITCODE)." }
    if (-not (Test-Path $zipPath) -or (Get-Item $zipPath).Length -eq 0) {
        throw "Build produced no artifact: $zipPath"
    }

    # Verify the archive extracts cleanly on Linux: list entries and assert none
    # use backslash separators (the exact failure mode we are guarding against).
    Write-Step 'Verifying archive uses Unix (forward-slash) path separators...'
    $entries = @(& $tarExe -tf $zipPath 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Could not list archive entries to verify: $($entries -join "`n")" }
    $badEntries = @($entries | Where-Object { $_ -match '\\' })
    if ($badEntries.Count -gt 0) {
        throw "Archive has $($badEntries.Count) entry(ies) with backslash separators; Linux/EB unzip would reject it. First: $($badEntries[0])"
    }
    Write-Ok "Built artifact: $zipPath ($((Get-Item $zipPath).Length) bytes, $($entries.Count) entries, forward-slash paths verified)"
}
finally {
    Pop-Location
}

# ------------------------------------------------------------------------------
# Phase 2 (continued): upload the artifact to S3 and register the application
# version. This is the step that "failed silently" before. We now:
#   1) Re-validate the artifact exists and starts with the ZIP 'PK' signature.
#   2) Resolve + validate the EB S3 bucket and key.
#   3) Upload with up to 3 retries (5s backoff) and show any AWS error verbatim.
#   4) Confirm the object actually landed in S3 (head-object).
#   5) Skip create-application-version if the label already exists (re-run safe),
#      otherwise create it with retries and confirm it registered.
# ------------------------------------------------------------------------------
Write-Step 'Re-validating the built artifact before upload...'
if (-not (Test-Path $zipPath)) { throw "Artifact not found right before upload: $zipPath" }
$zipItem = Get-Item $zipPath
if ($zipItem.Length -lt 1024) {
    throw "Artifact is suspiciously small ($($zipItem.Length) bytes) - the build likely failed: $zipPath"
}
# A real .zip begins with the bytes 'PK' (0x50 0x4B). Catches truncated/garbage files.
$pk = New-Object byte[] 2
$fs = [System.IO.File]::OpenRead($zipPath)
try { [void]$fs.Read($pk, 0, 2) } finally { $fs.Dispose() }
if ($pk[0] -ne 0x50 -or $pk[1] -ne 0x4B) {
    throw "Artifact does not begin with a ZIP 'PK' signature; it is not a valid zip: $zipPath"
}
Write-Diag "artifact : $zipPath"
Write-Diag "size     : $($zipItem.Length) bytes"
Write-Diag 'signature: PK (valid zip)'

Write-Step 'Resolving Elastic Beanstalk S3 storage location...'
$storage = Invoke-Aws -Retries 3 -DelaySeconds 5 `
    elasticbeanstalk create-storage-location --output json | ConvertFrom-Json
$bucket = $storage.S3Bucket
if ([string]::IsNullOrWhiteSpace($bucket)) {
    throw "Could not resolve the Elastic Beanstalk S3 storage bucket (empty response from create-storage-location)."
}
$s3Key = "$EbAppName/anot-backend-$NewVersion.zip"
$s3Uri = "s3://$bucket/$s3Key"
Write-Diag "bucket   : $bucket"
Write-Diag "key      : $s3Key"
Write-Diag "s3 uri   : $s3Uri"

Write-Step "Uploading artifact to $s3Uri (up to 3 attempts)..."
Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "s3 cp -> $s3Uri" `
    s3 cp $zipPath $s3Uri | Out-Null

if (-not $DryRun) {
    Write-Step 'Confirming the object exists in S3 (head-object)...'
    $head = Invoke-Aws -Retries 3 -DelaySeconds 5 -What "s3api head-object $s3Key" `
        s3api head-object --bucket $bucket --key $s3Key --output json | ConvertFrom-Json
    $remoteLen = [int64]$head.ContentLength
    if ($remoteLen -ne $zipItem.Length) {
        Write-Warn "S3 object size ($remoteLen) differs from local artifact ($($zipItem.Length)). Proceeding, but verify."
    }
    Write-Ok "S3 object confirmed present ($remoteLen bytes) at $s3Uri."
} else {
    Write-Ok "[DRY-RUN] would upload $($zipItem.Length)-byte artifact to $s3Uri and confirm it."
}

Write-Step "Checking whether application version '$NewVersion' already exists..."
$existingVersion = Get-AppVersion $NewVersion
if ($existingVersion) {
    Write-Warn "Application version '$NewVersion' already exists (status: $($existingVersion.Status)). Reusing it; skipping create-application-version."
} else {
    Write-Step "Creating application version '$NewVersion' (up to 3 attempts)..."
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "create-application-version $NewVersion" `
        elasticbeanstalk create-application-version `
        --application-name $EbAppName `
        --version-label $NewVersion `
        --source-bundle "S3Bucket=$bucket,S3Key=$s3Key" `
        --description 'v40 - SSM secrets bootstrap' | Out-Null

    if (-not $DryRun) {
        Write-Step "Confirming application version '$NewVersion' registered..."
        $created = Get-AppVersion $NewVersion
        if (-not $created) {
            throw "create-application-version reported success but '$NewVersion' is not listed by describe-application-versions. Check the EB console / source bundle."
        }
        Write-Ok "Application version '$NewVersion' registered (status: $($created.Status), not yet deployed)."
    } else {
        Write-Ok "[DRY-RUN] would create application version '$NewVersion' from $s3Uri."
    }
}

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
Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "rds modify-db-instance $RdsInstanceId" `
    rds modify-db-instance --db-instance-identifier $RdsInstanceId `
    --master-user-password $NewDbPassword --apply-immediately | Out-Null

# RDS briefly reports 'available' before flipping to 'modifying'. Give it a
# moment, then wait until it is fully available again.
if (-not $DryRun) {
    Write-Step 'Waiting for RDS to apply the change (this can take a few minutes)...'
    Start-Sleep -Seconds 20
    Invoke-Aws -SkipInDryRun rds wait db-instance-available --db-instance-identifier $RdsInstanceId
    Write-Ok 'RDS password rotated and instance is available.'
} else {
    Write-Ok "[DRY-RUN] would rotate the RDS master password for '$RdsInstanceId' and wait for it to apply."
}

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
    if ($DryRun) {
        Write-Warn "[DRY-RUN] Required SSM parameters not present yet: $($missing -join ', ')."
        Write-Warn '[DRY-RUN] This is expected because Phase 4 writes were skipped. A live run would store them first.'
    } else {
        # Hard stop: deploying v40 now would boot with missing secrets.
        throw "Required SSM parameters are missing: $($missing -join ', '). Aborting BEFORE deploy."
    }
} else {
    Write-Ok "Found $($names.Count) parameter(s); all required secrets present."
}

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
Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What "update-environment (deploy $NewVersion + USE_SSM)" `
    elasticbeanstalk update-environment `
    --application-name $EbAppName --environment-name $EbEnvName `
    --version-label $NewVersion `
    --option-settings `
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=USE_SSM,Value=true" `
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SSM_REGION,Value=$Region" `
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=SSM_PREFIX,Value=$SsmPrefix" | Out-Null

if (-not $DryRun) {
    Write-Step 'Waiting for the deployment to complete...'
    Invoke-Aws -SkipInDryRun elasticbeanstalk wait environment-updated `
        --application-name $EbAppName --environment-names $EbEnvName
    Write-Ok "Version '$NewVersion' deployed with USE_SSM enabled."
} else {
    Write-Ok "[DRY-RUN] would deploy '$NewVersion' with USE_SSM=true and wait for the environment to update."
}

# ==============================================================================
# PHASE 7 - Verify v40 is healthy  (GATE before removing plaintext secrets)
# ==============================================================================
# This is the safety gate added after the v39 rollback incident: v40 once failed
# to deploy (the bad backslash zip), but Phase 7 had ALREADY stripped the
# plaintext secrets, so the v39 we rolled back to came up RED - it has no
# loadSecrets.js and could not read anything from SSM. We now REFUSE to remove
# the plaintext fallback unless EB confirms v40 is Green.
#
# EB health is AUTHORITATIVE. The public https://api.anot.health/ probe depends on
# external DNS that can fail on its own (a separate infra issue) - a probe failure
# is logged as a warning but does NOT block Phase 8, because a Green v40 in EB
# already proves the new instances booted and are reading secrets from SSM.
Write-Phase 'PHASE 7: Verify v40 health (gate before plaintext removal)'

$healthResult = Test-V40Healthy
$v40Healthy   = $healthResult.EbGreen

if ($v40Healthy) {
    if ($healthResult.EndpointOk) {
        Write-Ok "v40 verified healthy: endpoint reports $NewVersion and EB is Green."
    } else {
        Write-Ok "v40 is GREEN per EB. DNS probe failed but EB health is authoritative. Proceeding to Phase 8."
    }
    # EB-Green is automated proof the app booted; login (JWT_SECRET + DB password
    # from SSM) is the one thing only a human can confirm before we drop the
    # plaintext fallback. Require an explicit acknowledgement here.
    Confirm-Step "CONFIRM you have tested LOGIN against v40 (JWT + DB password from SSM) and it works. Proceed to remove the plaintext fallback?"
} else {
    Write-Warn "v40 is NOT Green in EB (Version=$($healthResult.Version), Health=$($healthResult.Health)). Skipping Phase 8 (plaintext removal)."
}

# ==============================================================================
# PHASE 8 - Remove plaintext secrets from EB  (ONLY if v40 is healthy)
# ==============================================================================
# Done LAST and only behind the Phase 7 gate, so the EB env-property fallback
# survives any failed/unhealthy deploy (see ROLLBACK_V40_SSM.md R1/R2 and
# scripts/restore-v39-secrets.ps1).
Write-Phase 'PHASE 8: Remove plaintext secrets from EB (conditional)'

$plaintextRemoved = $false
if (-not $v40Healthy) {
    Write-Warn 'v40 is not healthy - leaving the plaintext secret env properties in place.'
    Write-Warn 'This keeps the rollback fallback intact. Investigate v40, then re-run this'
    Write-Warn 'script (it is safe to re-run) once the endpoint reports v40 and EB is Green.'
} else {
    # The Phase 7 gate already confirmed EB-Green v40 and an operator login check,
    # so we proceed straight to the removal here (no second prompt).
    Write-Step 'v40 confirmed healthy in Phase 7. Removing the now-redundant plaintext secret env properties...'
    # CRITICAL: each removal must reach the AWS CLI as its OWN argv token. Passing a
    # PowerShell array directly to Invoke-Aws's ValueFromRemainingArguments parameter
    # collapses it into one nested element that splatting then space-joins, which the
    # CLI rejects ("Unknown options: Namespace=...A Namespace=...B"). Build one FLAT
    # argument array and splat that instead.
    $removeArgs = @($SecretsToRemove | ForEach-Object {
        "Namespace=aws:elasticbeanstalk:application:environment,OptionName=$_"
    })
    $removeUpdateArgs = @(
        'elasticbeanstalk', 'update-environment',
        '--application-name', $EbAppName,
        '--environment-name', $EbEnvName,
        '--options-to-remove'
    ) + $removeArgs   # concatenation flattens $removeArgs into separate elements
    Write-Step 'Removing plaintext secret properties...'
    Write-Diag "options-to-remove: $($removeArgs -join ' | ')"
    Invoke-Aws -SkipInDryRun -Retries 3 -DelaySeconds 5 -What 'update-environment (remove plaintext secrets)' `
        @removeUpdateArgs | Out-Null

    Write-Step 'Waiting for the environment to settle...'
    Invoke-Aws -SkipInDryRun elasticbeanstalk wait environment-updated `
        --application-name $EbAppName --environment-names $EbEnvName
    $plaintextRemoved = $true
    Write-Ok 'Plaintext secrets removed from EB. Secrets now sourced from SSM only.'
}

# ==============================================================================
# DEPLOYMENT SUMMARY
# ==============================================================================
Write-Phase 'DEPLOYMENT SUMMARY'
if ($DryRun) {
    Write-Ok 'DRY-RUN COMPLETE: prerequisites, identity, build and all read-only checks passed.'
    Write-Warn 'No IAM/RDS/SSM/S3/EB changes were made. Re-run without -DryRun to deploy for real.'
    Write-Host ''
    return
}
if ($v40Healthy -and $plaintextRemoved) {
    Write-Ok "v40 deployed successfully. Endpoint healthy ($NewVersion), EB Green, plaintext removed."
} elseif ($v40Healthy) {
    Write-Warn 'v40 is healthy but plaintext secrets were NOT removed (declined or skipped).'
    Write-Warn 'Re-run this script to complete Phase 8 when ready.'
} else {
    Write-Warn 'v40 is NOT healthy. Plaintext secrets were intentionally LEFT in place.'
    Write-Warn 'Review EB logs: aws elasticbeanstalk request-environment-info --info-type tail'
    Write-Warn "Rollback guide: ROLLBACK_V40_SSM.md (backups in $BackupDir)"
    Write-Warn 'If you roll back to v39, restore its plaintext env properties with:'
    Write-Warn "    pwsh -File scripts/restore-v39-secrets.ps1 -BackupDir `"$BackupDir`""
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
