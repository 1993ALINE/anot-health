<#
================================================================================
 restore-v39-secrets.ps1  -  Re-apply the backed-up plaintext secret env
                             properties to Elastic Beanstalk (rollback helper)
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHY THIS EXISTS:
   deploy-v40-ssm.ps1 Phase 8 removes the plaintext secret env properties from
   EB once v40 is verified healthy on SSM. v39 does NOT have loadSecrets.js and
   cannot read secrets from SSM, so if you ever roll back to v39 AFTER those
   plaintext properties were removed, v39 comes up RED with no credentials.

   This script reads the EB config export captured by the deploy
   (backup-v39-*/eb-config-settings-v39.json) and PUTS those plaintext secret
   env properties back onto the environment, so a rolled-back v39 can boot.

 WHAT IT RESTORES:
   Only the application-environment option settings whose OptionName is in the
   secret list below (the same set deploy-v40-ssm.ps1 removes). Nothing else in
   the environment configuration is touched.

 *** IMPORTANT - DATABASE PASSWORD CAVEAT ***
   deploy-v40-ssm.ps1 Phase 3 ROTATES the RDS master password. The DB_PASSWORD /
   DATABASE_URL stored in this backup are the PRE-rotation (v39) values. They
   only work if the RDS password currently matches them - i.e. you also restored
   the pre-deploy RDS snapshot, or reset the RDS master password back to the
   backed-up value. If you restored secrets but the DB still rejects logins,
   that is the cause. See ROLLBACK_V40_SSM.md.

 USAGE:
   pwsh -File scripts/restore-v39-secrets.ps1 -BackupDir "..\backup-v39-YYYYMMDD-HHMMSS"
   pwsh -File scripts/restore-v39-secrets.ps1 -BackupDir <dir> -DryRun   # preview only
   pwsh -File scripts/restore-v39-secrets.ps1 -BackupDir <dir> -Force    # no prompt

 If -BackupDir is omitted, the most recent backup-v39-* folder under the project
 root is used.
================================================================================
#>

[CmdletBinding()]
param(
    [string]$BackupDir,
    [switch]$DryRun,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$Region    = 'ap-southeast-1'
$EbAppName = 'anot-backend'
$EbEnvName = 'anot-backend-prod'
$EnvNamespace = 'aws:elasticbeanstalk:application:environment'

# Same set deploy-v40-ssm.ps1 strips in Phase 8. Only these OptionNames are
# restored from the backup; everything else in the export is ignored.
$SecretsToRestore = @(
    'JWT_SECRET', 'SETTINGS_ENCRYPTION_KEY', 'DATABASE_URL', 'DB_PASSWORD',
    'DB_USER', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'ANTHROPIC_API_KEY',
    'DEEPGRAM_API_KEY', 'DEEPGRAM_WEBHOOK_SECRET', 'SENTRY_DSN',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'
)

$env:AWS_DEFAULT_REGION = $Region
$ProjectDir = Split-Path -Parent $PSScriptRoot
#endregion

#region --------------------------- HELPERS -----------------------------------
function Write-Step { param([string]$Message) Write-Host "  -> $Message" -ForegroundColor Gray }
function Write-Ok   { param([string]$Message) Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  [!!] $Message" -ForegroundColor Yellow }

function Invoke-Aws {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
    $output = & aws @CliArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "aws $($CliArgs -join ' ') failed (exit $LASTEXITCODE):`n$output"
    }
    return $output
}
#endregion

Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Cyan
Write-Host '  RESTORE v39 PLAINTEXT SECRETS TO ELASTIC BEANSTALK' -ForegroundColor Cyan
Write-Host ('=' * 78) -ForegroundColor Cyan

# ------------------------------------------------------------------------------
# Resolve the backup directory (most recent backup-v39-* if not specified).
# ------------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($BackupDir)) {
    Write-Step 'No -BackupDir given; locating the most recent backup-v39-* folder...'
    $candidate = Get-ChildItem -Path $ProjectDir -Directory -Filter 'backup-v39-*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $candidate) {
        throw "No backup-v39-* folder found under $ProjectDir. Pass -BackupDir explicitly."
    }
    $BackupDir = $candidate.FullName
}
if (-not (Test-Path $BackupDir)) { throw "Backup directory not found: $BackupDir" }
Write-Step "Using backup directory: $BackupDir"

$configFile = Join-Path $BackupDir 'eb-config-settings-v39.json'
if (-not (Test-Path $configFile)) {
    throw "Backup config not found: $configFile (expected the deploy's EB config export)."
}
Write-Step "Reading EB config export: $configFile"

# ------------------------------------------------------------------------------
# Parse the export and pull out the secret env properties to restore.
# Structure: { ConfigurationSettings: [ { OptionSettings: [ {Namespace,OptionName,Value} ] } ] }
# ------------------------------------------------------------------------------
$config = Get-Content -Path $configFile -Raw | ConvertFrom-Json
if (-not $config.ConfigurationSettings -or $config.ConfigurationSettings.Count -eq 0) {
    throw "Backup export has no ConfigurationSettings: $configFile"
}
$opts = $config.ConfigurationSettings[0].OptionSettings

$toRestore = @()
$missing = @()
foreach ($name in $SecretsToRestore) {
    $match = @($opts | Where-Object {
        $_.Namespace -eq $EnvNamespace -and $_.OptionName -eq $name
    })
    if ($match.Count -gt 0 -and -not [string]::IsNullOrEmpty([string]$match[0].Value)) {
        $toRestore += [ordered]@{
            Namespace  = $EnvNamespace
            OptionName = $name
            Value      = [string]$match[0].Value
        }
    } else {
        $missing += $name
    }
}

if ($toRestore.Count -eq 0) {
    throw "No restorable secret env properties found in the backup. Nothing to do."
}

Write-Step "Will restore $($toRestore.Count) secret env property(ies):"
foreach ($o in $toRestore) { Write-Host "    + $($o.OptionName)" -ForegroundColor DarkGray }
if ($missing.Count -gt 0) {
    Write-Warn "Not present/empty in backup (skipped): $($missing -join ', ')"
}

Write-Host ''
Write-Warn 'CAVEAT: DB_PASSWORD / DATABASE_URL here are the PRE-rotation v39 values.'
Write-Warn 'They only work if the RDS password currently matches them (restore the'
Write-Warn 'pre-deploy snapshot or reset the RDS master password). See ROLLBACK_V40_SSM.md.'
Write-Host ''

if ($DryRun) {
    Write-Ok 'DryRun: no changes applied. Re-run without -DryRun to apply.'
    return
}

if (-not $Force) {
    $answer = Read-Host "  Apply these $($toRestore.Count) property(ies) to '$EbEnvName'?  [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw 'Aborted by operator.' }
}

# ------------------------------------------------------------------------------
# Apply via a JSON --option-settings file. JSON (not the comma-shorthand) is
# required because values like DATABASE_URL contain commas / special chars.
# ------------------------------------------------------------------------------
$optionsFile = Join-Path $BackupDir 'restore-option-settings.json'
$json = ConvertTo-Json -InputObject @($toRestore) -Depth 5
# Windows PowerShell 5.1 unwraps a single-element array (drops the surrounding
# [ ]); the AWS CLI requires a JSON list here, so re-wrap when needed.
if ($json.TrimStart() -notmatch '^\[') { $json = "[$json]" }
$json | Out-File -FilePath $optionsFile -Encoding ascii
Write-Step "Wrote option-settings document to $optionsFile"

Write-Step "Applying secret env properties to '$EbEnvName'..."
Invoke-Aws elasticbeanstalk update-environment `
    --application-name $EbAppName --environment-name $EbEnvName `
    --option-settings "file://$optionsFile" | Out-Null

Write-Step 'Waiting for the environment to settle...'
Invoke-Aws elasticbeanstalk wait environment-updated `
    --application-name $EbAppName --environment-names $EbEnvName
Write-Ok "Restored $($toRestore.Count) plaintext secret env property(ies) to '$EbEnvName'."

Write-Host ''
Write-Host '  Next steps:' -ForegroundColor Yellow
Write-Host '    [ ] Confirm the rolled-back app version (v39) is the one deployed.' -ForegroundColor Yellow
Write-Host '    [ ] If DB logins still fail, the RDS password no longer matches the' -ForegroundColor Yellow
Write-Host '        backed-up DATABASE_URL - restore the pre-deploy RDS snapshot or' -ForegroundColor Yellow
Write-Host '        reset the RDS master password. See ROLLBACK_V40_SSM.md.' -ForegroundColor Yellow
Write-Host '    [ ] Verify EB reports Health=Green before declaring rollback complete.' -ForegroundColor Yellow
Write-Host ''
