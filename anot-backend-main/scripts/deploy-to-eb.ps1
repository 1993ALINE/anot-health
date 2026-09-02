<#
================================================================================
 deploy-to-eb.ps1  -  Package and deploy the Anot backend to AWS Elastic Beanstalk
================================================================================

 Builds a Linux-compatible deployment zip (forward-slash paths via tar, never
 Compress-Archive), uploads it to the EB S3 bucket, registers a new application
 version, updates anot-backend-prod, waits for Ready/Green, and verifies
 GET https://app.anot.health/api/health returns 200.

 Prerequisites:
   - AWS CLI v2 installed and configured (credentials with EB + S3 access)
   - Windows tar (bsdtar) at %WINDIR%\System32\tar.exe

 Usage (from the backend project root):
   powershell -File scripts/deploy-to-eb.ps1

 Optional parameters:
   -VersionPrefix  Version prefix (default: v43)
   -OutputDir      Where to write the zip (default: $env:TEMP, else current dir)
   -Region         AWS region (default: ap-southeast-1)
   -HealthUrl      URL to verify after deploy (default: https://app.anot.health/api/health)
   -WaitTimeoutSec Max seconds for primary EB Ready/Green poll (default: 600)
   -GracePeriodSec Extra seconds after primary timeout for recovery polling (default: 300)
   -SkipVerify     Skip GET /api/health verification after deploy
================================================================================
#>

[CmdletBinding()]
param(
    [string]$VersionPrefix = 'v43',
    [string]$OutputDir = '',
    [string]$Region = 'ap-southeast-1',
    [string]$HealthUrl = 'https://app.anot.health/api/health',
    [int]$WaitTimeoutSec = 600,
    [int]$GracePeriodSec = 300,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

# ΓöÇΓöÇΓöÇ CONFIG ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

$EbAppName   = 'anot-backend'
$EbEnvName   = 'anot-backend-prod'
$S3Bucket    = 'elasticbeanstalk-ap-southeast-1-625242092266'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir  = Split-Path -Parent $ScriptDir

$Timestamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$VersionLabel = "$VersionPrefix-$Timestamp"
$ZipFileName = "anot-backend-$VersionPrefix-$Timestamp.zip"
$S3Key       = $ZipFileName

$script:CurrentPhase = 'init'

# ΓöÇΓöÇΓöÇ OUTPUT HELPERS ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function Write-Phase {
    param([string]$Message)
    $script:CurrentPhase = $Message
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host "  $Message" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}

function Write-Step {
    param([string]$Message)
    Write-Host "  -> $Message" -ForegroundColor Gray
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  [FAIL] $Message" -ForegroundColor Red
}

# ΓöÇΓöÇΓöÇ AWS CLI WRAPPER ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function Invoke-Aws {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [string]$What,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$CliArgs
    )

    if (-not $CliArgs -or $CliArgs.Count -eq 0) {
        throw 'Invoke-Aws called with no AWS CLI arguments.'
    }

    $cmdText = "aws $($CliArgs -join ' ')"
    $label   = if ($What) { $What } else { $cmdText }

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
        }
        else {
            $outParts += [string]$item
        }
    }
    $stdout = ($outParts -join "`n")
    $stderr = (($errParts -join "`n")).Trim()

    if ($code -eq 0) { return $stdout }

    $detail = @(
        "AWS CLI call FAILED",
        "  what     : $label",
        "  command  : $cmdText",
        "  region   : $Region",
        "  exit code: $code"
    )
    if ($stderr) { $detail += "  aws error: $stderr" }
    if ($stdout) { $detail += "  aws stdout: $stdout" }
    throw ($detail -join "`n")
}

function Get-EbEnvironment {
    $json = Invoke-Aws -What "describe-environments $EbEnvName" `
        elasticbeanstalk describe-environments `
        --application-name $EbAppName `
        --environment-names $EbEnvName `
        --region $Region `
        --output json | ConvertFrom-Json

    if (-not $json.Environments -or @($json.Environments).Count -eq 0) {
        throw "EB environment '$EbEnvName' not found in region $Region."
    }
    return @($json.Environments)[0]
}

function Test-EbReady {
    param([object]$Env)

    $statusReady = ($Env.Status -eq 'Ready')
    $healthOk    = ($Env.Health -eq 'Green') -or ($Env.HealthStatus -eq 'Ok')
    return ($statusReady -and $healthOk)
}

function Write-EbInstanceHealthSnapshot {
    try {
        $json = Invoke-Aws -What "describe-instances-health $EbEnvName" `
            elasticbeanstalk describe-instances-health `
            --environment-name $EbEnvName `
            --attribute-names All `
            --region $Region `
            --output json | ConvertFrom-Json

        $instances = @($json.InstanceHealthList)
        if ($instances.Count -eq 0) {
            Write-Step '  Instance health: (no instances reported yet)'
            return
        }

        foreach ($inst in $instances) {
            $causeText = if ($inst.Causes) { ($inst.Causes -join '; ') } else { 'none' }
            Write-Step ("  Instance {0}: HealthStatus={1}  Color={2}  Causes={3}" -f `
                $inst.InstanceId, $inst.HealthStatus, $inst.Color, $causeText)
        }
    }
    catch {
        Write-Step "  Instance health: unavailable ($($_.Exception.Message))"
    }
}

function Wait-EbDeploymentReady {
    param(
        [string]$ExpectedVersionLabel,
        [int]$PrimaryTimeoutSec,
        [int]$RecoveryTimeoutSec
    )

    $pollIntervalSec = 15
    $maxIntervalSec  = 45
    $deadline        = (Get-Date).AddSeconds($PrimaryTimeoutSec)
    $pollCount       = 0
    $finalEnv        = $null
    $deploySucceeded = $false

    Write-Step "Primary wait: up to $PrimaryTimeoutSec seconds (poll interval starts at ${pollIntervalSec}s, backs off to ${maxIntervalSec}s) ..."

    while ((Get-Date) -lt $deadline) {
        $pollCount++
        $finalEnv = Get-EbEnvironment
        Write-Step ("Poll {0}: Status={1}  Health={2}  HealthStatus={3}  VersionLabel={4}" -f `
            $pollCount, $finalEnv.Status, $finalEnv.Health, $finalEnv.HealthStatus, $finalEnv.VersionLabel)
        Write-EbInstanceHealthSnapshot

        if (Test-EbReady -Env $finalEnv) {
            if ($finalEnv.VersionLabel -ne $ExpectedVersionLabel) {
                Write-Step "Environment is Ready/Green but version is '$($finalEnv.VersionLabel)' (expected '$ExpectedVersionLabel'); continuing to wait ..."
            }
            else {
                Write-Ok "Environment is Ready with Green/Ok health on version $ExpectedVersionLabel"
                $deploySucceeded = $true
                break
            }
        }

        Start-Sleep -Seconds $pollIntervalSec
        $pollIntervalSec = [Math]::Min($maxIntervalSec, [int][Math]::Ceiling($pollIntervalSec * 1.25))
    }

    if (-not $deploySucceeded) {
        Write-Step "Primary wait elapsed after $PrimaryTimeoutSec seconds - checking actual EB status before failing ..."
        $finalEnv = Get-EbEnvironment
        Write-Step ("Final primary snapshot: Status={0}  Health={1}  HealthStatus={2}  VersionLabel={3}" -f `
            $finalEnv.Status, $finalEnv.Health, $finalEnv.HealthStatus, $finalEnv.VersionLabel)
        Write-EbInstanceHealthSnapshot

        if ((Test-EbReady -Env $finalEnv) -and ($finalEnv.VersionLabel -eq $ExpectedVersionLabel)) {
            Write-Ok "Environment reached Ready/Green on target version during final primary check"
            $deploySucceeded = $true
        }
    }

    if (-not $deploySucceeded -and $RecoveryTimeoutSec -gt 0) {
        Write-Step "Entering recovery polling for up to $RecoveryTimeoutSec additional seconds ..."
        $recoveryDeadline = (Get-Date).AddSeconds($RecoveryTimeoutSec)
        $recoveryPoll     = 0
        $pollIntervalSec  = 15

        while ((Get-Date) -lt $recoveryDeadline) {
            $recoveryPoll++
            $finalEnv = Get-EbEnvironment
            Write-Step ("Recovery poll {0}: Status={1}  Health={2}  HealthStatus={3}  VersionLabel={4}" -f `
                $recoveryPoll, $finalEnv.Status, $finalEnv.Health, $finalEnv.HealthStatus, $finalEnv.VersionLabel)
            Write-EbInstanceHealthSnapshot

            if ((Test-EbReady -Env $finalEnv) -and ($finalEnv.VersionLabel -eq $ExpectedVersionLabel)) {
                Write-Ok "Environment reached Ready/Green on target version during recovery period"
                $deploySucceeded = $true
                break
            }

            Start-Sleep -Seconds $pollIntervalSec
            $pollIntervalSec = [Math]::Min($maxIntervalSec, [int][Math]::Ceiling($pollIntervalSec * 1.25))
        }
    }

    if (-not $deploySucceeded) {
        $finalEnv = Get-EbEnvironment
        $detail = @(
            "EB deployment did not reach Ready/Green on version '$ExpectedVersionLabel' within $($PrimaryTimeoutSec + $RecoveryTimeoutSec) seconds.",
            "  Current Status       : $($finalEnv.Status)",
            "  Current Health       : $($finalEnv.Health)",
            "  Current HealthStatus : $($finalEnv.HealthStatus)",
            "  Current VersionLabel : $($finalEnv.VersionLabel)"
        )
        if ((Test-EbReady -Env $finalEnv) -and ($finalEnv.VersionLabel -ne $ExpectedVersionLabel)) {
            $detail += "  Note: Environment is Ready/Green but still on a previous version - check EB Events in the AWS Console."
        }
        elseif ($finalEnv.Status -in @('Updating', 'Launching', 'Processing')) {
            $detail += "  Note: Environment is still transitioning - it may complete successfully; verify in the AWS Console."
        }
        throw ($detail -join "`n")
    }

    return $finalEnv
}

# ΓöÇΓöÇΓöÇ FAILURE TRAP ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  DEPLOYMENT FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    Write-Host "  Error : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Time  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    exit 1
}

# ΓöÇΓöÇΓöÇ PRE-FLIGHT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

Write-Phase 'Pre-flight checks'

$awsVersion = & aws --version 2>&1
if ($LASTEXITCODE -ne 0) {
    throw 'AWS CLI is not installed or not on PATH. Install AWS CLI v2 and retry.'
}
Write-Ok "AWS CLI found: $awsVersion"

$tarExe = Join-Path $env:WINDIR 'System32\tar.exe'
if (-not (Test-Path $tarExe)) {
    throw "Windows tar (bsdtar) not found at $tarExe. EB bundles require tar for forward-slash paths."
}
Write-Ok "tar found: $tarExe"

if (-not (Test-Path $ProjectDir)) {
    throw "Project directory not found: $ProjectDir"
}
Write-Ok "Project directory: $ProjectDir"

$identity = Invoke-Aws -What 'sts get-caller-identity' sts get-caller-identity --output json | ConvertFrom-Json
Write-Ok "AWS identity: $($identity.Arn)"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    if (-not [string]::IsNullOrWhiteSpace($env:TEMP) -and (Test-Path $env:TEMP)) {
        $OutputDir = $env:TEMP
    }
    else {
        $OutputDir = Get-Location
    }
}
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
Write-Ok "Artifact output directory: $OutputDir"

# ΓöÇΓöÇΓöÇ STEP 1: BUILD ZIP ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

Write-Phase 'Step 1/5 - Build deployment zip'

$ZipPath = Join-Path $OutputDir $ZipFileName
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

Write-Step "Creating $ZipPath from $ProjectDir ..."
Write-Step 'Using tar (NOT Compress-Archive) so zip entries use forward slashes for Linux/EB.'

Push-Location $ProjectDir
try {
    # Exclude paths requested by the operator plus safety exclusions from the
    # production runbook (PHI uploads, local build artifacts).
    $tarArgs = @(
        '-a', '-c', '-f', $ZipPath,
        '--exclude', 'node_modules',
        '--exclude', 'scripts/node_modules',
        '--exclude', 'test-fixtures',
        '--exclude', '.git',
        '--exclude', 'dist',
        '--exclude', 'coverage',
        '--exclude', '.env',
        '--exclude', '.env.local',
        '--exclude', 'src/uploads',
        '--exclude', '*.webm',
        '--exclude', '*.zip',
        '--exclude', '*.tar.gz',
        '--exclude', 'backup-*',
        '--exclude', 'artifacts',
        '.'
    )

    & $tarExe @tarArgs
    if ($LASTEXITCODE -ne 0) {
        throw "tar failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path $ZipPath)) {
    throw "Zip artifact was not created: $ZipPath"
}

$zipSizeKb = [math]::Round((Get-Item $ZipPath).Length / 1KB, 1)
Write-Ok "Created $ZipFileName ($zipSizeKb KB)"

# Verify nginx + platform configs are inside the artifact (413 fix depends on these).
Write-Step 'Verifying deployment zip includes nginx body-size configs...'
$zipList = & $tarExe -t -f $ZipPath 2>&1
$requiredEntries = @(
    '.ebextensions/01_nginx_bodysize.config',
    '.platform/nginx/conf.d/01_client_max_body_size.conf'
)
foreach ($entry in $requiredEntries) {
    $found = @($zipList | Where-Object { $_ -eq $entry -or $_ -like "*$entry" }).Count -gt 0
    if (-not $found) {
        throw "Deployment zip missing required entry: $entry (nginx 413 fix will not deploy)."
    }
    Write-Ok "Zip contains $entry"
}

# ΓöÇΓöÇΓöÇ STEP 2: UPLOAD TO S3 ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

Write-Phase 'Step 2/5 - Upload zip to S3'

$S3Uri = "s3://$S3Bucket/$S3Key"
Write-Step "Uploading to $S3Uri ..."

Invoke-Aws -What "s3 cp $ZipFileName" `
    s3 cp $ZipPath $S3Uri --region $Region | Out-Null

Write-Ok "Uploaded to $S3Uri"

# ΓöÇΓöÇΓöÇ STEP 3: CREATE APPLICATION VERSION ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

Write-Phase 'Step 3/5 - Create EB application version'

Write-Step "Version label: $VersionLabel"

Invoke-Aws -What "create-application-version $VersionLabel" `
    elasticbeanstalk create-application-version `
    --application-name $EbAppName `
    --version-label $VersionLabel `
    --source-bundle "S3Bucket=$S3Bucket,S3Key=$S3Key" `
    --region $Region `
    --output json | Out-Null

Write-Ok "Application version '$VersionLabel' registered"

# ΓöÇΓöÇΓöÇ STEP 4: UPDATE ENVIRONMENT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

Write-Phase 'Step 4/5 - Deploy to EB environment'

Write-Step "Updating $EbEnvName to version $VersionLabel ..."

Invoke-Aws -What "update-environment $EbEnvName" `
    elasticbeanstalk update-environment `
    --environment-name $EbEnvName `
    --version-label $VersionLabel `
    --region $Region `
    --output json | Out-Null

Write-Step "Waiting for Status=Ready and Health=Green (primary timeout: $WaitTimeoutSec sec, recovery grace: $GracePeriodSec sec) ..."

$finalEnv = Wait-EbDeploymentReady -ExpectedVersionLabel $VersionLabel `
    -PrimaryTimeoutSec $WaitTimeoutSec -RecoveryTimeoutSec $GracePeriodSec

# ΓöÇΓöÇΓöÇ STEP 5: VERIFY /api/health ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

if ($SkipVerify) {
    Write-Phase 'Step 5/5 - Verify /api/health endpoint (skipped)'
    Write-Step 'SkipVerify was set - not calling /api/health.'
    Write-Host ''
    Write-Host '  Deployment submitted; EB environment is Ready/Green on target version' -ForegroundColor Green
    Write-Host "  Version label : $VersionLabel" -ForegroundColor Green
    Write-Host "  S3 artifact   : $S3Uri" -ForegroundColor Green
    Write-Host ''
    exit 0
}

Write-Phase 'Step 5/5 - Verify /api/health endpoint'

Write-Step "GET $HealthUrl ..."

try {
    $response = Invoke-WebRequest -Uri $HealthUrl -Method GET -UseBasicParsing -TimeoutSec 30
    $statusCode = [int]$response.StatusCode
    $body       = $response.Content
}
catch {
    $statusCode = 0
    if ($_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode.value__
    }
    $body = $_.Exception.Message
}

if ($statusCode -eq 404) {
    Write-Fail "Deployment verification failed: GET $HealthUrl returned 404 Not Found."
    Write-Fail 'The new version is live in EB but /api/health is missing - check server.js routing and CloudFront origin path.'
    exit 1
}

if ($statusCode -ne 200) {
    Write-Fail "Deployment verification failed: GET $HealthUrl returned HTTP $statusCode."
    Write-Fail "Response: $body"
    exit 1
}

$parsed = $null
try {
    $parsed = $body | ConvertFrom-Json
}
catch {
    Write-Fail "Deployment verification failed: response is not valid JSON."
    Write-Fail "Response: $body"
    exit 1
}

if ($parsed.status -ne 'ok' -and $parsed.status -ne 'healthy') {
    Write-Fail "Deployment verification failed: unexpected JSON payload."
    Write-Fail "Expected status='ok' (or legacy 'healthy')"
    Write-Fail "Got: $body"
    exit 1
}

Write-Host ''
Write-Host '  Deployment successful, /api/health is responding' -ForegroundColor Green
Write-Host "  Version label : $VersionLabel" -ForegroundColor Green
Write-Host "  S3 artifact   : $S3Uri" -ForegroundColor Green
Write-Host "  Health body   : $body" -ForegroundColor Green
Write-Host ''

exit 0
