<#
================================================================================
 validate-production.ps1  -  Comprehensive PRODUCTION READINESS validation for
                             the Anot Health platform
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHAT THIS SCRIPT DOES:
   Runs a broad, READ-ONLY health/security/operability audit of every major
   piece of the Anot Health production stack and produces:
     * Console   : color-coded, timestamped progress + a final summary.
     * HTML       : a full readiness report at dist/production-validation-report.html
     * JSON       : structured results at dist/validation-results.json

   It NEVER mutates AWS. Every AWS call is a Describe/Get/List, every HTTP call
   is a GET, and the only optional write is an S3 round-trip that is OFF unless
   you pass -AllowWriteTests (and even then it cleans up after itself).

 THE NINE SECTIONS (mirrors the production-readiness checklist):
   1. INFRASTRUCTURE HEALTH  EB, RDS, CloudFront, S3, security groups, ASG.
   2. CONNECTIVITY & DNS      DNS, frontend, CloudFront backend, direct-origin
                              and direct-S3 access (both expected to be blocked).
   3. SECURITY VALIDATION     WAF rules + logging, encryption (S3/RDS/TLS),
                              origin restriction, root keys, ops IAM user,
                              S3 public-access-block.
   4. LOGGING & MONITORING    Log groups, retention, scaling alarms, RDS enhanced
                              monitoring, recent log activity.
   5. DATABASE HEALTH         Engine/version, MultiAZ, storage, backups, users,
                              connections.
   6. APPLICATION TESTS       Frontend load, API health, DB connectivity (via the
                              API), SSM Parameter Store, S3 audio bucket access.
   7. AUTO-SCALING            Policies, alarms, metric type, recent activities.
   8. IDENTIFIED ISSUES       Every WARN/FAIL collected + categorized + remediated.
   9. READINESS SCORE         0-100 score, blockers vs deferred, go/no-go.

 MODES:
   -DryRun   Read-only PLAN: enumerates every check it WOULD run and writes the
             report/JSON, but performs NO AWS or network calls. Safe anywhere.
   -Live     Actually executes every read-only validation against AWS + the
             public endpoints. (This is the default if neither switch is given.)
   -Verbose  Emit extra diagnostic detail (raw values) via the verbose stream.

 RESILIENCE:
   * Every check is isolated: a single failing/denied call is recorded as a
     result and never aborts the run. The script always reaches the summary.
   * Transient AWS/network failures are retried with backoff.
   * Permissions matter: some checks (e.g. root-key presence, IAM user listing)
     require admin-grade reads. When the ops user lacks them the check degrades
     to INFO/WARN with a clear note rather than failing the whole audit.

 USAGE:
   powershell -File scripts/validate-production.ps1 -DryRun
   powershell -File scripts/validate-production.ps1 -Live
   powershell -File scripts/validate-production.ps1 -Live -Verbose
   powershell -File scripts/validate-production.ps1 -Live -AllowWriteTests
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Live,
    [switch]$AllowWriteTests,
    [int]$RecentLogMinutes = 5,
    [int]$ExpectedUserCount = 5,
    [int]$ExpectedRetentionDays = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId   = '625242092266'
$Region         = 'ap-southeast-1'        # regional resources (EB, RDS, EC2, ASG, S3 control)
$GlobalRegion   = 'us-east-1'             # CloudFront + CLOUDFRONT-scoped WAFv2 live here

# Elastic Beanstalk
$EbAppName      = 'anot-backend'
$EbEnvName      = 'anot-backend-prod'
$EbEnvId        = 'e-g7bj3ndsck'

# RDS
$RdsInstanceId  = 'anot-postgres'
$RdsMonitoringRole = 'rds-monitoring-role'

# CloudFront / WAF
$DistributionId = 'E6SKNV1EEXNPP'
$CloudFrontHost = 'd3t0m4s0ayca85.cloudfront.net'
$WebAclName     = 'anot-cloudfront-waf'
$WebAclScope    = 'CLOUDFRONT'
$WafLogGroup    = 'aws-waf-logs-anot-cloudfront'

# S3
$AudioBucket    = "anot-audio-$AwsAccountId"
$FrontendBucket = "anot-frontend-$AwsAccountId"

# DNS / public endpoints
$FrontendHost   = 'app.anot.health'
$ApiHost        = 'api.anot.health'
$FrontendUrl    = "https://$FrontendHost/"
$CloudFrontUrl  = "https://$CloudFrontHost/"

# SSM
$SsmPrefix      = '/anot/prod'

# Logging / monitoring
$EbLogGroupPrefix = "/aws/elasticbeanstalk/$EbEnvName"
$EbEngineLogGroup = "$EbLogGroupPrefix/var/log/eb-engine.log"
$RdsOsLogGroup    = 'RDSOSMetrics'

# Auto-scaling (created by enable-eb-autoscaling.ps1)
$ScaleUpPolicy   = "$EbEnvName-cpu-scale-up"
$ScaleDownPolicy = "$EbEnvName-cpu-scale-down"
$CpuHighAlarm    = "$EbEnvName-cpu-high"
$CpuLowAlarm     = "$EbEnvName-cpu-low"

# IAM ops user
$OpsUserName     = 'anot-ops'
$OpsPolicyName   = 'anot-ops-prod-policy'

$ProjectDir   = Split-Path -Parent $PSScriptRoot
$ArtifactDir  = Join-Path $ProjectDir 'dist'
$HtmlReport   = Join-Path $ArtifactDir 'production-validation-report.html'
$JsonReport   = Join-Path $ArtifactDir 'validation-results.json'
$StartTime    = Get-Date

# Default to LIVE if the operator gave neither switch.
if (-not $DryRun -and -not $Live) { $Live = $true }
if ($DryRun) { $Live = $false }

$env:AWS_DEFAULT_REGION = $Region
$env:AWS_PAGER = ''
# Force modern TLS for every Invoke-WebRequest probe (PS 5.1 may default lower).
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

# Section ordering / titles used by the report and summary.
$SectionTitles = [ordered]@{
    '1' = 'INFRASTRUCTURE HEALTH'
    '2' = 'CONNECTIVITY & DNS'
    '3' = 'SECURITY VALIDATION'
    '4' = 'LOGGING & MONITORING'
    '5' = 'DATABASE HEALTH'
    '6' = 'APPLICATION TESTS'
    '7' = 'AUTO-SCALING VALIDATION'
}

$script:Results = New-Object System.Collections.Generic.List[object]
#endregion

#region --------------------------- CONSOLE HELPERS ---------------------------
function Write-Phase {
    param([string]$Title)
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}
function Write-Step { param([string]$Message) Write-Host "  -> $Message" -ForegroundColor Gray }
function Write-Diag { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }

# Map a status to a console color.
function Get-StatusColor {
    param([string]$Status)
    switch ($Status) {
        'PASS' { 'Green' }
        'WARN' { 'Yellow' }
        'FAIL' { 'Red' }
        'INFO' { 'Cyan' }
        'SKIP' { 'DarkGray' }
        default { 'Gray' }
    }
}
#endregion

#region --------------------------- RESULT MODEL ------------------------------
# Record one check outcome: print it live (color + timestamp) and stash it for
# the summary/report. Status is one of PASS/WARN/FAIL/INFO/SKIP.
function Add-Result {
    param(
        [string]$Section,
        [string]$Name,
        [ValidateSet('PASS','WARN','FAIL','INFO','SKIP')] [string]$Status,
        [string]$Detail = '',
        [ValidateSet('CRITICAL','HIGH','MEDIUM','LOW','')] [string]$Severity = '',
        [string]$Remediation = '',
        [int]$Weight = 1,
        [object]$Data = $null
    )
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $rec = [pscustomobject]@{
        Timestamp   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Section     = $Section
        SectionName = if ($SectionTitles.Contains($Section)) { $SectionTitles[$Section] } else { $Section }
        Name        = $Name
        Status      = $Status
        Severity    = $Severity
        Detail      = $Detail
        Remediation = $Remediation
        Weight      = $Weight
        Data        = $Data
    }
    $script:Results.Add($rec)

    $color = Get-StatusColor -Status $Status
    $sevTxt = if ($Severity) { " ($Severity)" } else { '' }
    Write-Host ("  [{0}] [{1,-4}]{2} {3}" -f $stamp, $Status, $sevTxt, $Name) -ForegroundColor $color
    if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
    if ($Remediation -and ($Status -eq 'FAIL' -or $Status -eq 'WARN')) {
        Write-Host "         remediation: $Remediation" -ForegroundColor DarkYellow
    }
}

# Small constructors for the hashtables that check scriptblocks return. Each
# returns @{ Status; Detail; Severity; Remediation; Data } (+ optional Name).
function R-Pass { param([string]$Detail,[object]$Data=$null) @{ Status='PASS'; Detail=$Detail; Data=$Data } }
function R-Info { param([string]$Detail,[object]$Data=$null) @{ Status='INFO'; Detail=$Detail; Data=$Data } }
function R-Skip { param([string]$Detail,[object]$Data=$null) @{ Status='SKIP'; Detail=$Detail; Data=$Data } }
function R-Warn {
    param([string]$Detail,[string]$Severity='MEDIUM',[string]$Remediation='',[object]$Data=$null)
    @{ Status='WARN'; Detail=$Detail; Severity=$Severity; Remediation=$Remediation; Data=$Data }
}
function R-Fail {
    param([string]$Detail,[string]$Severity='HIGH',[string]$Remediation='',[object]$Data=$null)
    @{ Status='FAIL'; Detail=$Detail; Severity=$Severity; Remediation=$Remediation; Data=$Data }
}

# Run one check. In -DryRun it records a SKIP (the plan) without executing.
# In live mode it runs $Test, which returns one result hashtable OR an array of
# them; each is recorded. Any thrown error becomes a single FAIL (never aborts).
function Invoke-Check {
    param(
        [string]$Section,
        [string]$Name,
        [int]$Weight = 1,
        [scriptblock]$Test
    )
    if ($DryRun) {
        Add-Result -Section $Section -Name $Name -Status 'SKIP' -Weight $Weight `
            -Detail 'Dry-run: read-only plan only (this check was not executed).'
        return
    }
    try {
        $out = & $Test
        $items = @($out) | Where-Object { $_ -ne $null }
        if ($items.Count -eq 0) {
            Add-Result -Section $Section -Name $Name -Status 'INFO' -Weight $Weight -Detail 'No result produced.'
            return
        }
        foreach ($item in $items) {
            $nm  = if ($item.ContainsKey('Name') -and $item.Name) { $item.Name } else { $Name }
            $sev = if ($item.ContainsKey('Severity')) { $item.Severity } else { '' }
            $rem = if ($item.ContainsKey('Remediation')) { $item.Remediation } else { '' }
            $dat = if ($item.ContainsKey('Data')) { $item.Data } else { $null }
            $det = if ($item.ContainsKey('Detail')) { $item.Detail } else { '' }
            Add-Result -Section $Section -Name $nm -Status $item.Status -Weight $Weight `
                -Detail $det -Severity $sev -Remediation $rem -Data $dat
        }
    }
    catch {
        Add-Result -Section $Section -Name $Name -Status 'FAIL' -Weight $Weight `
            -Detail "Check raised an error: $($_.Exception.Message)" -Severity 'MEDIUM' `
            -Remediation 'Investigate the validation error; an AWS call or probe failed unexpectedly.'
    }
}
#endregion

#region --------------------------- AWS / NET HELPERS -------------------------
# Non-throwing read-only AWS CLI wrapper. Returns a record:
#   @{ Ok; Code; Stdout; Stderr; Json }  (Json is parsed when output is JSON).
# Optionally pins a region for the call (used for CloudFront/WAF in us-east-1).
function Invoke-AwsRead {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [string]$What,
        [string]$UseRegion,
        [int]$Retries = 3,
        [int]$DelaySeconds = 4,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs
    )
    if (-not $CliArgs -or $CliArgs.Count -eq 0) { throw 'Invoke-AwsRead called with no AWS CLI arguments.' }

    $prevRegion = $env:AWS_DEFAULT_REGION
    if ($UseRegion) { $env:AWS_DEFAULT_REGION = $UseRegion }

    $result = [pscustomobject]@{ Ok = $false; Code = $null; Stdout = ''; Stderr = ''; Json = $null }
    try {
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
                Write-Verbose "AWS OK: $What"
                return $result
            }

            if ($attempt -lt $Retries) {
                Write-Verbose "AWS retry ($attempt/$Retries) for '$What' (exit $code): $stderr"
                Start-Sleep -Seconds $DelaySeconds
                continue
            }

            $result.Ok = $false; $result.Code = $code; $result.Stdout = $stdout; $result.Stderr = $stderr
            Write-Verbose "AWS FAIL: $What (exit $code): $stderr"
            return $result
        }
    }
    finally {
        $env:AWS_DEFAULT_REGION = $prevRegion
    }
}

# True if an AWS error string indicates a permission/authorization failure (so a
# check can degrade to INFO "could not verify" instead of a misleading FAIL).
function Test-AccessDenied {
    param([string]$Text)
    if (-not $Text) { return $false }
    return ($Text -match 'AccessDenied|UnauthorizedOperation|not authorized|AuthorizationError|is not authorized to perform')
}

# Probe a URL. Returns { Ok2xx; Code; Reachable; Error; Body } where Reachable is
# false only on a connection-level failure (timeout / refused / DNS). An HTTP
# error response (403/5xx) still counts as Reachable=true (the host answered).
function Invoke-Probe {
    param([string]$Url, [int]$TimeoutSec = 15, [int]$MaxRedirect = 5)
    $rec = [pscustomobject]@{ Ok2xx = $false; Code = $null; Reachable = $false; Error = $null; Body = '' }
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -MaximumRedirection $MaxRedirect -ErrorAction Stop
        $rec.Reachable = $true
        $rec.Code = [int]$resp.StatusCode
        $rec.Ok2xx = ($rec.Code -ge 200 -and $rec.Code -lt 300)
        try { $rec.Body = [string]$resp.Content } catch { $rec.Body = '' }
    }
    catch {
        $ex = $_.Exception
        $resp = $null
        if ($ex.PSObject.Properties.Name -contains 'Response') { $resp = $ex.Response }
        if ($resp) {
            $rec.Reachable = $true
            try { $rec.Code = [int]$resp.StatusCode } catch { $rec.Code = $null }
            if ($rec.Code) { $rec.Ok2xx = ($rec.Code -ge 200 -and $rec.Code -lt 300) }
        } else {
            $rec.Reachable = $false
        }
        $rec.Error = $ex.Message
    }
    return $rec
}

# Negotiate a TLS handshake to host:port and report the protocol that was agreed
# (e.g. Tls12 / Tls13). Used to confirm the endpoint serves TLS 1.2+.
function Get-TlsInfo {
    param([string]$HostName, [int]$Port = 443, [int]$TimeoutSec = 10)
    $info = [pscustomobject]@{ Ok = $false; Protocol = $null; Error = $null }
    $tcp = $null; $ssl = $null
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect($HostName, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($TimeoutSec))) {
            $info.Error = 'connect timeout'; return $info
        }
        $tcp.EndConnect($iar)
        $validate = [System.Net.Security.RemoteCertificateValidationCallback] { param($s,$c,$ch,$e) $true }
        $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $validate)
        $ssl.AuthenticateAsClient($HostName)
        $info.Ok = $true
        $info.Protocol = $ssl.SslProtocol.ToString()
    }
    catch { $info.Error = $_.Exception.Message }
    finally {
        if ($ssl) { try { $ssl.Dispose() } catch {} }
        if ($tcp) { try { $tcp.Close() } catch {} }
    }
    return $info
}

# Resolve a hostname to addresses (best-effort, non-throwing). Returns @() on
# failure. Uses Resolve-DnsName when available, otherwise .NET DNS.
function Resolve-HostAddresses {
    param([string]$HostName)
    try {
        if (Get-Command Resolve-DnsName -ErrorAction SilentlyContinue) {
            $r = Resolve-DnsName -Name $HostName -ErrorAction Stop
            return @($r | Where-Object { $_.PSObject.Properties.Name -contains 'IPAddress' -and $_.IPAddress } | ForEach-Object { $_.IPAddress })
        }
        $entries = [System.Net.Dns]::GetHostAddresses($HostName)
        return @($entries | ForEach-Object { $_.IPAddressToString })
    }
    catch { return @() }
}
#endregion

# ------------------------------------------------------------------------------
# Caches: a few expensive reads are shared by multiple sections.
# ------------------------------------------------------------------------------
$script:EbEnv      = $null
$script:Rds        = $null
$script:Dist       = $null
$script:WebAcl     = $null
$script:AsgName    = $null

# Resolve a value once and cache it, returning $null on any failure.
function Get-EbEnvCached {
    if ($null -ne $script:EbEnv) { return $script:EbEnv }
    $r = Invoke-AwsRead -What 'describe-environments' elasticbeanstalk describe-environments `
        --application-name $EbAppName --environment-names $EbEnvName --output json
    if ($r.Ok -and $r.Json -and @($r.Json.Environments).Count -gt 0) { $script:EbEnv = @($r.Json.Environments)[0] }
    return $script:EbEnv
}
function Get-RdsCached {
    if ($null -ne $script:Rds) { return $script:Rds }
    $r = Invoke-AwsRead -What 'describe-db-instances' rds describe-db-instances `
        --db-instance-identifier $RdsInstanceId --output json
    if ($r.Ok -and $r.Json -and @($r.Json.DBInstances).Count -gt 0) { $script:Rds = @($r.Json.DBInstances)[0] }
    return $script:Rds
}
function Get-DistCached {
    if ($null -ne $script:Dist) { return $script:Dist }
    $r = Invoke-AwsRead -What 'cloudfront get-distribution' -UseRegion $GlobalRegion `
        cloudfront get-distribution --id $DistributionId --output json
    if ($r.Ok -and $r.Json) { $script:Dist = $r.Json.Distribution }
    return $script:Dist
}

# =============================================================================
# Failure trap: surface the error, but still try to flush whatever we collected.
# =============================================================================
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  VALIDATE-PRODUCTION ABORTED (unexpected error)' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    Write-Host ''
    exit 1
}

# =============================================================================
# PRE-FLIGHT
# =============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity'

if ($DryRun) {
    Write-Step 'DRY-RUN MODE: enumerating planned checks only. No AWS or network calls will be made.'
} else {
    Write-Step 'LIVE MODE: running read-only validations against AWS + public endpoints.'
}

$IdentityArn = '(unknown)'
$awsAvailable = $false
if (-not $DryRun) {
    Write-Step 'Checking AWS CLI is installed...'
    $awsVersion = (& aws --version) 2>&1
    if ($LASTEXITCODE -eq 0) {
        $awsAvailable = $true
        Write-Diag "AWS CLI: $awsVersion"
        $idr = Invoke-AwsRead -What 'sts get-caller-identity' sts get-caller-identity --output json
        if ($idr.Ok -and $idr.Json) {
            $IdentityArn = $idr.Json.Arn
            Write-Diag "Authenticated as: $IdentityArn"
            if ($idr.Json.Account -ne $AwsAccountId) {
                Write-Host "  [!!] WARNING: authenticated account $($idr.Json.Account) != expected $AwsAccountId" -ForegroundColor Yellow
            }
        } else {
            Write-Host '  [!!] Could not verify AWS identity (sts get-caller-identity failed). AWS checks will report errors.' -ForegroundColor Yellow
        }
    } else {
        Write-Host '  [!!] AWS CLI not found on PATH. AWS-dependent checks will FAIL; install AWS CLI v2.' -ForegroundColor Yellow
    }
}

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null

# =============================================================================
# SECTION 1 - INFRASTRUCTURE HEALTH
# =============================================================================
Write-Phase 'SECTION 1: INFRASTRUCTURE HEALTH'

Invoke-Check -Section '1' -Name 'Elastic Beanstalk environment health' -Weight 3 -Test {
    $env = Get-EbEnvCached
    if ($null -eq $env) {
        return R-Fail "EB environment '$EbEnvName' not found or describe-environments failed." 'CRITICAL' `
            'Confirm the EB application/environment names and that the identity can call elasticbeanstalk:DescribeEnvironments.'
    }
    $detail = "id=$($env.EnvironmentId) status=$($env.Status) health=$($env.Health) ($($env.HealthStatus)) version=$($env.VersionLabel)"
    if ($env.Status -eq 'Ready' -and ($env.Health -eq 'Green')) { return R-Pass $detail $env }
    if ($env.Health -eq 'Yellow') {
        return R-Warn "$detail - environment is degraded (Yellow)." 'HIGH' `
            'Inspect EB events and instance/app logs; resolve the cause of the degraded health.' $env
    }
    return R-Fail "$detail - environment is not Green/Ready." 'CRITICAL' `
        'Investigate EB events; the environment is unhealthy and may be serving errors.' $env
}

Invoke-Check -Section '1' -Name 'EB capacity (running instances)' -Weight 1 -Test {
    $r = Invoke-AwsRead -What 'describe-environment-resources' elasticbeanstalk describe-environment-resources `
        --environment-name $EbEnvName --output json
    if (-not $r.Ok) { return R-Warn "Could not read environment resources: $($r.Stderr)" 'LOW' 'Verify elasticbeanstalk:DescribeEnvironmentResources permission.' }
    $instances = @($r.Json.EnvironmentResources.Instances)
    $asgs = @($r.Json.EnvironmentResources.AutoScalingGroups)
    if ($asgs.Count -gt 0) { $script:AsgName = $asgs[0].Name }
    if ($instances.Count -ge 1) { return R-Pass "running instances: $($instances.Count); asg: $script:AsgName" }
    return R-Fail 'No running instances reported for the environment.' 'CRITICAL' `
        'Check the Auto Scaling Group desired capacity and instance launch failures.'
}

Invoke-Check -Section '1' -Name 'RDS instance status' -Weight 3 -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Fail "RDS instance '$RdsInstanceId' not found or describe failed." 'CRITICAL' 'Verify the DB identifier and rds:DescribeDBInstances permission.' }
    $detail = "status=$($db.DBInstanceStatus) class=$($db.DBInstanceClass) multiAZ=$($db.MultiAZ) storage=$($db.AllocatedStorage)GB backupRetention=$($db.BackupRetentionPeriod)d"
    if ($db.DBInstanceStatus -eq 'available') { return R-Pass $detail $db }
    return R-Fail "$detail - instance not 'available'." 'CRITICAL' 'Investigate RDS events; the database is not in the available state.' $db
}

Invoke-Check -Section '1' -Name 'CloudFront distribution status' -Weight 3 -Test {
    $d = Get-DistCached
    if ($null -eq $d) { return R-Fail "CloudFront distribution '$DistributionId' not found or get-distribution failed." 'CRITICAL' 'Verify the distribution id and cloudfront:GetDistribution permission.' }
    $webAcl = ''
    if ($d.DistributionConfig.PSObject.Properties.Name -contains 'WebACLId') { $webAcl = [string]$d.DistributionConfig.WebACLId }
    $wafTxt = if ($webAcl) { 'WAF attached' } else { 'NO WAF attached' }
    $detail = "status=$($d.Status) enabled=$($d.DistributionConfig.Enabled) domain=$($d.DomainName); $wafTxt"
    if ($d.Status -eq 'Deployed' -and $d.DistributionConfig.Enabled) {
        if ($webAcl) { return R-Pass $detail $d }
        return R-Warn "$detail" 'HIGH' 'Attach a WAFv2 WebACL to CloudFront (scripts/enable-cloudfront-waf.ps1).' $d
    }
    return R-Warn "$detail - not Deployed/Enabled." 'MEDIUM' 'Wait for deployment to finish or re-enable the distribution.' $d
}

foreach ($bkt in @($AudioBucket, $FrontendBucket)) {
    Invoke-Check -Section '1' -Name "S3 bucket reachable: $bkt" -Weight 2 -Test {
        $r = Invoke-AwsRead -What "s3api head-bucket $bkt" s3api head-bucket --bucket $bkt
        if ($r.Ok) { return R-Pass "bucket '$bkt' exists and is accessible." }
        if (Test-AccessDenied $r.Stderr) { return R-Warn "bucket '$bkt' access denied to this identity." 'MEDIUM' 'Grant s3:ListBucket on this bucket or run as an identity that has it.' }
        return R-Fail "bucket '$bkt' not reachable: $($r.Stderr)" 'HIGH' 'Confirm the bucket exists in this account/region.'
    }
}

Invoke-Check -Section '1' -Name 'VPC security group origin restriction' -Weight 2 -Test {
    $env = Get-EbEnvCached
    if ($null -eq $env) { return R-Skip 'EB environment unavailable; cannot resolve the instance security group.' }
    $res = Invoke-AwsRead -What 'describe-environment-resources (sg)' elasticbeanstalk describe-environment-resources --environment-name $EbEnvName --output json
    if (-not $res.Ok) { return R-Warn "Could not read environment resources to find the SG: $($res.Stderr)" 'LOW' 'Verify EB describe permission.' }
    $instId = $null
    $insts = @($res.Json.EnvironmentResources.Instances)
    if ($insts.Count -gt 0) { $instId = $insts[0].Id }
    if (-not $instId) { return R-Skip 'No running instance to read security groups from.' }
    $ir = Invoke-AwsRead -What 'describe-instances (sg)' ec2 describe-instances --instance-ids $instId --output json
    if (-not $ir.Ok) { return R-Warn "Could not read instance security groups: $($ir.Stderr)" 'LOW' 'Verify ec2:DescribeInstances permission.' }
    $sgId = @(@($ir.Json.Reservations)[0].Instances[0].SecurityGroups)[0].GroupId
    $sgr = Invoke-AwsRead -What 'describe-security-groups' ec2 describe-security-groups --group-ids $sgId --output json
    if (-not $sgr.Ok) { return R-Warn "Could not read SG '$sgId': $($sgr.Stderr)" 'LOW' 'Verify ec2:DescribeSecurityGroups permission.' }
    $perms = @(@($sgr.Json.SecurityGroups)[0].IpPermissions)
    $openPorts = @()
    $hasPrefix = $false
    foreach ($p in $perms) {
        if ($p.IpProtocol -ne 'tcp') { continue }
        $from = if ($p.PSObject.Properties.Name -contains 'FromPort') { [int]$p.FromPort } else { -1 }
        if ($from -in 80, 443) {
            foreach ($r in @($p.IpRanges)) { if ($r.CidrIp -eq '0.0.0.0/0') { $openPorts += $from } }
            foreach ($r in @($p.Ipv6Ranges)) { if ($r.CidrIpv6 -eq '::/0') { $openPorts += $from } }
            if ($p.PSObject.Properties.Name -contains 'PrefixListIds' -and @($p.PrefixListIds).Count -gt 0) { $hasPrefix = $true }
        }
    }
    $openPorts = @($openPorts | Sort-Object -Unique)
    if ($openPorts.Count -gt 0) {
        return R-Fail "SG $sgId allows 0.0.0.0/0 on tcp/$($openPorts -join ',') - origin is open to the internet." 'HIGH' `
            'Restrict 80/443 to the CloudFront origin-facing prefix list (scripts/restrict-backend-to-cloudfront.ps1).'
    }
    if ($hasPrefix) { return R-Pass "SG $sgId restricts 80/443 to a managed prefix list (CloudFront only); no open 0.0.0.0/0 on web ports." }
    return R-Warn "SG $sgId has no open web ports but also no CloudFront prefix-list allow rule found." 'LOW' 'Verify CloudFront can still reach the origin (prefix-list ingress rule).'
}

Invoke-Check -Section '1' -Name 'Auto Scaling Group capacity & policies' -Weight 1 -Test {
    if (-not $script:AsgName) {
        $res = Invoke-AwsRead -What 'describe-environment-resources (asg)' elasticbeanstalk describe-environment-resources --environment-name $EbEnvName --output json
        if ($res.Ok -and @($res.Json.EnvironmentResources.AutoScalingGroups).Count -gt 0) { $script:AsgName = @($res.Json.EnvironmentResources.AutoScalingGroups)[0].Name }
    }
    if (-not $script:AsgName) { return R-Warn 'Could not resolve the EB-managed Auto Scaling Group.' 'MEDIUM' 'Verify the environment has an ASG and EB describe permissions.' }
    $r = Invoke-AwsRead -What 'describe-auto-scaling-groups' autoscaling describe-auto-scaling-groups --auto-scaling-group-names $script:AsgName --output json
    if (-not $r.Ok) { return R-Warn "Could not read ASG '$script:AsgName': $($r.Stderr)" 'MEDIUM' 'Verify autoscaling:DescribeAutoScalingGroups permission.' }
    $asg = @($r.Json.AutoScalingGroups)[0]
    $detail = "asg=$($asg.AutoScalingGroupName) min=$($asg.MinSize) max=$($asg.MaxSize) desired=$($asg.DesiredCapacity)"
    if ([int]$asg.MaxSize -gt [int]$asg.MinSize) { return R-Pass "$detail (scale-out headroom present)." $asg }
    return R-Warn "$detail - max == min, so the group cannot scale out." 'MEDIUM' 'Set MaxSize > MinSize (scripts/enable-eb-autoscaling.ps1).' $asg
}

# =============================================================================
# SECTION 2 - CONNECTIVITY & DNS
# =============================================================================
Write-Phase 'SECTION 2: CONNECTIVITY & DNS'

foreach ($h in @($ApiHost, $FrontendHost)) {
    Invoke-Check -Section '2' -Name "DNS resolution: $h" -Weight 2 -Test {
        $addrs = Resolve-HostAddresses -HostName $h
        if ($addrs.Count -gt 0) { return R-Pass "$h resolves to: $($addrs -join ', ')" }
        return R-Fail "$h did not resolve to any address." 'HIGH' 'Create/repair the DNS record for this hostname (Route 53 / your DNS provider).'
    }
}

Invoke-Check -Section '2' -Name "Frontend endpoint $FrontendUrl returns 200" -Weight 3 -Test {
    $p = Invoke-Probe -Url $FrontendUrl -TimeoutSec 20
    if ($p.Ok2xx) { return R-Pass "GET $FrontendUrl -> HTTP $($p.Code)" }
    if ($p.Reachable) { return R-Fail "GET $FrontendUrl -> HTTP $($p.Code) (expected 200)." 'HIGH' 'Investigate CloudFront/S3 origin and cache behavior for the SPA.' }
    return R-Fail "GET $FrontendUrl unreachable: $($p.Error)" 'HIGH' 'Check DNS, the CloudFront distribution, and the SPA origin.'
}

Invoke-Check -Section '2' -Name "Backend via CloudFront $CloudFrontUrl returns 200" -Weight 3 -Test {
    $p = Invoke-Probe -Url $CloudFrontUrl -TimeoutSec 20
    if ($p.Ok2xx) { return R-Pass "GET $CloudFrontUrl -> HTTP $($p.Code)" }
    if ($p.Reachable) { return R-Warn "GET $CloudFrontUrl -> HTTP $($p.Code) (expected 200)." 'MEDIUM' 'Confirm the default cache behavior/origin is healthy.' }
    return R-Fail "GET $CloudFrontUrl unreachable: $($p.Error)" 'HIGH' 'Check the CloudFront distribution status and origin.'
}

Invoke-Check -Section '2' -Name 'Direct EB origin access is blocked (expect 403/timeout)' -Weight 2 -Test {
    $env = Get-EbEnvCached
    if ($null -eq $env -or -not $env.CNAME) { return R-Skip 'EB CNAME unavailable; cannot test direct-origin access.' }
    $url = "http://$($env.CNAME)/"
    $p = Invoke-Probe -Url $url -TimeoutSec 12 -MaxRedirect 0
    if (-not $p.Reachable) { return R-Pass "Direct origin $url is unreachable (connection blocked) - as intended." }
    if ($p.Code -in 403, 502, 503) { return R-Pass "Direct origin $url -> HTTP $($p.Code) (blocked/denied) - as intended." }
    return R-Warn "Direct origin $url -> HTTP $($p.Code) (still reachable). It should be restricted to CloudFront." 'HIGH' `
        'Restrict the origin SG to the CloudFront prefix list (scripts/restrict-backend-to-cloudfront.ps1).'
}

Invoke-Check -Section '2' -Name 'Direct S3 frontend access is blocked (expect 403)' -Weight 1 -Test {
    $url = "https://$FrontendBucket.s3.$Region.amazonaws.com/"
    $p = Invoke-Probe -Url $url -TimeoutSec 12 -MaxRedirect 0
    if (-not $p.Reachable) { return R-Pass "Direct S3 endpoint unreachable - as intended." }
    if ($p.Code -in 403, 404) { return R-Pass "Direct S3 endpoint $url -> HTTP $($p.Code) (denied) - as intended." }
    if ($p.Code -eq 200) { return R-Warn "Direct S3 endpoint returned 200 - the bucket may be publicly readable." 'MEDIUM' 'Serve via CloudFront with OAC and block public bucket access.' }
    return R-Info "Direct S3 endpoint $url -> HTTP $($p.Code)."
}

# =============================================================================
# SECTION 3 - SECURITY VALIDATION
# =============================================================================
Write-Phase 'SECTION 3: SECURITY VALIDATION'

# Resolve + cache the CLOUDFRONT WebACL once.
function Get-WebAclCached {
    if ($null -ne $script:WebAcl) { return $script:WebAcl }
    $list = Invoke-AwsRead -What 'wafv2 list-web-acls' -UseRegion $GlobalRegion wafv2 list-web-acls --scope $WebAclScope --output json
    if (-not $list.Ok -or -not $list.Json) { return $null }
    $summary = @($list.Json.WebACLs | Where-Object { $_.Name -eq $WebAclName })
    if ($summary.Count -eq 0) { return $null }
    $s = $summary[0]
    $get = Invoke-AwsRead -What 'wafv2 get-web-acl' -UseRegion $GlobalRegion wafv2 get-web-acl --name $WebAclName --scope $WebAclScope --id $s.Id --output json
    if ($get.Ok -and $get.Json) { $script:WebAcl = [pscustomobject]@{ Summary = $s; WebACL = $get.Json.WebACL } }
    return $script:WebAcl
}

Invoke-Check -Section '3' -Name 'WAF rules active' -Weight 3 -Test {
    $w = Get-WebAclCached
    if ($null -eq $w) { return R-Fail "CLOUDFRONT WebACL '$WebAclName' not found." 'HIGH' 'Create/attach the WAF WebACL (scripts/enable-cloudfront-waf.ps1).' }
    $rules = @($w.WebACL.Rules)
    $names = @($rules | ForEach-Object { $_.Name })
    if ($rules.Count -gt 0) { return R-Pass "WebACL '$WebAclName' has $($rules.Count) rule(s): $($names -join ', ')" $names }
    return R-Warn "WebACL '$WebAclName' exists but has no rules." 'HIGH' 'Add managed + rate-limit rules to the WebACL.'
}

Invoke-Check -Section '3' -Name 'WAF logging enabled' -Weight 1 -Test {
    $w = Get-WebAclCached
    if ($null -eq $w) { return R-Skip 'WebACL not found; cannot check logging.' }
    $arn = $w.Summary.ARN
    $r = Invoke-AwsRead -What 'wafv2 get-logging-configuration' -UseRegion $GlobalRegion wafv2 get-logging-configuration --resource-arn $arn --output json
    if ($r.Ok -and $r.Json) {
        $dests = @($r.Json.LoggingConfiguration.LogDestinationConfigs)
        return R-Pass "WAF logging enabled -> $($dests -join ', ')"
    }
    if ($r.Stderr -match 'WAFNonexistentItem|not.*found') { return R-Warn 'WAF logging is not configured.' 'MEDIUM' 'Enable WAF logging to a CloudWatch aws-waf-logs-* group (scripts/enable-cloudfront-waf.ps1).' }
    return R-Warn "Could not read WAF logging configuration: $($r.Stderr)" 'LOW' 'Verify wafv2:GetLoggingConfiguration permission.'
}

foreach ($bkt in @($AudioBucket, $FrontendBucket)) {
    Invoke-Check -Section '3' -Name "S3 encryption at rest: $bkt" -Weight 2 -Test {
        $r = Invoke-AwsRead -What "get-bucket-encryption $bkt" s3api get-bucket-encryption --bucket $bkt --output json
        if ($r.Ok -and $r.Json) {
            $alg = @($r.Json.ServerSideEncryptionConfiguration.Rules)[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm
            return R-Pass "bucket '$bkt' default encryption: $alg"
        }
        if ($r.Stderr -match 'ServerSideEncryptionConfigurationNotFoundError') {
            return R-Fail "bucket '$bkt' has NO default encryption." 'HIGH' 'Enable default SSE (AES-256 or aws:kms) on the bucket.'
        }
        if (Test-AccessDenied $r.Stderr) { return R-Info "bucket '$bkt' encryption: access denied to this identity." }
        return R-Warn "Could not read encryption for '$bkt': $($r.Stderr)" 'LOW' 'Verify s3:GetEncryptionConfiguration permission.'
    }
}

Invoke-Check -Section '3' -Name 'RDS encryption at rest (KMS)' -Weight 3 -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS instance unavailable.' }
    if ($db.StorageEncrypted) { return R-Pass "RDS storage encrypted (KMS key: $($db.KmsKeyId))" }
    return R-Fail 'RDS storage is NOT encrypted at rest.' 'CRITICAL' 'Encryption must be set at creation; restore from an encrypted snapshot to remediate.'
}

Invoke-Check -Section '3' -Name 'TLS 1.2+ on public endpoints' -Weight 2 -Test {
    $out = @()
    foreach ($h in @($FrontendHost, $CloudFrontHost)) {
        $t = Get-TlsInfo -HostName $h
        $res = $null
        if ($t.Ok) {
            $proto = $t.Protocol
            $isModern = ($proto -match 'Tls12|Tls13|1\.2|1\.3')
            if ($isModern) { $res = R-Pass "$h negotiated $proto" }
            else { $res = R-Warn "$h negotiated $proto (below TLS 1.2)." 'HIGH' 'Disable TLS < 1.2 (CloudFront security policy TLSv1.2_2021).' }
        } else {
            $res = R-Warn "$h TLS handshake failed: $($t.Error)" 'LOW' 'Verify the endpoint serves HTTPS.'
        }
        $res.Name = "TLS: $h"
        $out += $res
    }
    return $out
}

Invoke-Check -Section '3' -Name 'Root account has no access keys' -Weight 3 -Test {
    $r = Invoke-AwsRead -What 'iam get-account-summary' iam get-account-summary --output json
    if ($r.Ok -and $r.Json) {
        $present = [int]$r.Json.SummaryMap.AccountAccessKeysPresent
        if ($present -eq 0) { return R-Pass 'Root account has no programmatic access keys (AccountAccessKeysPresent=0).' }
        return R-Fail "Root account HAS $present programmatic access key(s)." 'CRITICAL' 'Delete root access keys in the IAM console; operate via a scoped IAM user.'
    }
    if (Test-AccessDenied $r.Stderr) { return R-Info 'Cannot read account summary with this identity (iam:GetAccountSummary denied); run as admin to verify root keys.' }
    return R-Warn "Could not read account summary: $($r.Stderr)" 'LOW' 'Verify iam:GetAccountSummary permission.'
}

Invoke-Check -Section '3' -Name "IAM ops user '$OpsUserName' exists with policy" -Weight 1 -Test {
    $u = Invoke-AwsRead -What 'iam get-user' iam get-user --user-name $OpsUserName --output json
    if (-not $u.Ok) {
        if (Test-AccessDenied $u.Stderr) { return R-Info "Cannot read IAM user '$OpsUserName' (iam:GetUser denied to this identity)." }
        if ($u.Stderr -match 'NoSuchEntity') { return R-Warn "IAM ops user '$OpsUserName' does not exist." 'MEDIUM' 'Create the scoped ops user (scripts/create-iam-ops-user.ps1).' }
        return R-Warn "Could not read IAM user '$OpsUserName': $($u.Stderr)" 'LOW' 'Verify iam:GetUser permission.'
    }
    $pol = Invoke-AwsRead -What 'iam list-attached-user-policies' iam list-attached-user-policies --user-name $OpsUserName --output json
    if ($pol.Ok -and $pol.Json) {
        $names = @($pol.Json.AttachedPolicies | ForEach-Object { $_.PolicyName })
        if ($names -contains $OpsPolicyName) { return R-Pass "ops user '$OpsUserName' exists with policy '$OpsPolicyName' attached." }
        return R-Warn "ops user '$OpsUserName' exists but '$OpsPolicyName' is not attached (has: $($names -join ', '))." 'MEDIUM' 'Attach the scoped managed policy to the ops user.'
    }
    return R-Pass "ops user '$OpsUserName' exists (could not enumerate attached policies)."
}

foreach ($bkt in @($AudioBucket, $FrontendBucket)) {
    Invoke-Check -Section '3' -Name "S3 public access block: $bkt" -Weight 2 -Test {
        $r = Invoke-AwsRead -What "get-public-access-block $bkt" s3api get-public-access-block --bucket $bkt --output json
        if ($r.Ok -and $r.Json) {
            $c = $r.Json.PublicAccessBlockConfiguration
            $all = ($c.BlockPublicAcls -and $c.IgnorePublicAcls -and $c.BlockPublicPolicy -and $c.RestrictPublicBuckets)
            if ($all) { return R-Pass "bucket '$bkt' blocks all public access." }
            return R-Warn "bucket '$bkt' public-access-block is partial (BlockPublicAcls=$($c.BlockPublicAcls) IgnorePublicAcls=$($c.IgnorePublicAcls) BlockPublicPolicy=$($c.BlockPublicPolicy) RestrictPublicBuckets=$($c.RestrictPublicBuckets))." 'MEDIUM' 'Enable all four public-access-block settings.'
        }
        if ($r.Stderr -match 'NoSuchPublicAccessBlockConfiguration') {
            return R-Warn "bucket '$bkt' has NO public-access-block configuration." 'HIGH' 'Apply a full public-access-block to the bucket (block all 4).'
        }
        if (Test-AccessDenied $r.Stderr) { return R-Info "bucket '$bkt' public-access-block: access denied to this identity." }
        return R-Warn "Could not read public-access-block for '$bkt': $($r.Stderr)" 'LOW' 'Verify s3:GetBucketPublicAccessBlock permission.'
    }
}

# =============================================================================
# SECTION 4 - LOGGING & MONITORING
# =============================================================================
Write-Phase 'SECTION 4: LOGGING & MONITORING'

Invoke-Check -Section '4' -Name 'EB CloudWatch log groups exist' -Weight 2 -Test {
    $r = Invoke-AwsRead -What 'logs describe-log-groups (eb)' logs describe-log-groups --log-group-name-prefix $EbLogGroupPrefix --output json
    if (-not $r.Ok) { return R-Warn "Could not list EB log groups: $($r.Stderr)" 'MEDIUM' 'Verify logs:DescribeLogGroups permission.' }
    $groups = @($r.Json.logGroups)
    if ($groups.Count -gt 0) { return R-Pass "found $($groups.Count) EB log group(s) under '$EbLogGroupPrefix'." $groups }
    return R-Warn "No EB log groups found under '$EbLogGroupPrefix'." 'HIGH' 'Enable EB instance log streaming (scripts/enable-eb-cloudwatch-logs.ps1).'
}

Invoke-Check -Section '4' -Name 'RDS OS-metrics log group exists' -Weight 1 -Test {
    $r = Invoke-AwsRead -What 'logs describe-log-groups (rds)' logs describe-log-groups --log-group-name-prefix $RdsOsLogGroup --output json
    if ($r.Ok -and @($r.Json.logGroups | Where-Object { $_.logGroupName -eq $RdsOsLogGroup }).Count -gt 0) {
        return R-Pass "log group '$RdsOsLogGroup' exists (RDS enhanced monitoring sink)."
    }
    return R-Warn "log group '$RdsOsLogGroup' not found." 'MEDIUM' 'Enable RDS enhanced monitoring (scripts/enable-rds-enhanced-monitoring.ps1).'
}

Invoke-Check -Section '4' -Name 'WAF log group exists' -Weight 1 -Test {
    $r = Invoke-AwsRead -What 'logs describe-log-groups (waf)' -UseRegion $GlobalRegion logs describe-log-groups --log-group-name-prefix $WafLogGroup --output json
    if ($r.Ok -and @($r.Json.logGroups | Where-Object { $_.logGroupName -eq $WafLogGroup }).Count -gt 0) {
        return R-Pass "WAF log group '$WafLogGroup' exists (us-east-1)."
    }
    return R-Warn "WAF log group '$WafLogGroup' not found in us-east-1." 'LOW' 'Enable WAF logging (scripts/enable-cloudfront-waf.ps1).'
}

Invoke-Check -Section '4' -Name "Log retention = $ExpectedRetentionDays days (EB groups)" -Weight 1 -Test {
    $r = Invoke-AwsRead -What 'logs describe-log-groups (retention)' logs describe-log-groups --log-group-name-prefix $EbLogGroupPrefix --output json
    if (-not $r.Ok) { return R-Skip "Could not read EB log groups: $($r.Stderr)" }
    $groups = @($r.Json.logGroups)
    if ($groups.Count -eq 0) { return R-Skip 'No EB log groups to inspect for retention.' }
    $bad = @($groups | Where-Object { (-not ($_.PSObject.Properties.Name -contains 'retentionInDays')) -or ([int]$_.retentionInDays -ne $ExpectedRetentionDays) })
    if ($bad.Count -eq 0) { return R-Pass "all $($groups.Count) EB log group(s) retain $ExpectedRetentionDays days." }
    $sample = @($bad | Select-Object -First 3 | ForEach-Object { "$($_.logGroupName)=$(if ($_.PSObject.Properties.Name -contains 'retentionInDays') { $_.retentionInDays } else { 'never-expire' })" })
    return R-Warn "$($bad.Count)/$($groups.Count) EB log group(s) not set to $ExpectedRetentionDays d (e.g. $($sample -join '; '))." 'LOW' "Set retention to $ExpectedRetentionDays days on these log groups."
}

Invoke-Check -Section '4' -Name 'CloudWatch CPU scaling alarms configured' -Weight 1 -Test {
    $r = Invoke-AwsRead -What 'cloudwatch describe-alarms' cloudwatch describe-alarms --alarm-names $CpuHighAlarm $CpuLowAlarm --output json
    if (-not $r.Ok) { return R-Warn "Could not read alarms: $($r.Stderr)" 'MEDIUM' 'Verify cloudwatch:DescribeAlarms permission.' }
    $found = @($r.Json.MetricAlarms | ForEach-Object { $_.AlarmName })
    $missing = @(@($CpuHighAlarm, $CpuLowAlarm) | Where-Object { $found -notcontains $_ })
    if ($missing.Count -eq 0) { return R-Pass "both scaling alarms present: $($found -join ', ')." $found }
    return R-Warn "missing scaling alarm(s): $($missing -join ', ')." 'MEDIUM' 'Create CPU scaling alarms (scripts/enable-eb-autoscaling.ps1).'
}

Invoke-Check -Section '4' -Name 'RDS enhanced monitoring (60s)' -Weight 1 -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS instance unavailable.' }
    $interval = 0
    if ($db.PSObject.Properties.Name -contains 'MonitoringInterval' -and $db.MonitoringInterval) { $interval = [int]$db.MonitoringInterval }
    if ($interval -eq 60) { return R-Pass 'RDS enhanced monitoring enabled at 60s.' }
    if ($interval -gt 0) { return R-Pass "RDS enhanced monitoring enabled at ${interval}s." }
    return R-Warn 'RDS enhanced monitoring is disabled.' 'MEDIUM' 'Enable enhanced monitoring at 60s (scripts/enable-rds-enhanced-monitoring.ps1).'
}

Invoke-Check -Section '4' -Name "Recent EB log activity (last $RecentLogMinutes min)" -Weight 1 -Test {
    $startMs = [DateTimeOffset]::UtcNow.AddMinutes(-1 * $RecentLogMinutes).ToUnixTimeMilliseconds()
    $r = Invoke-AwsRead -What 'logs filter-log-events' logs filter-log-events --log-group-name $EbEngineLogGroup --start-time $startMs --limit 5 --output json
    if (-not $r.Ok) {
        if ($r.Stderr -match 'ResourceNotFoundException') { return R-Warn "log group '$EbEngineLogGroup' does not exist." 'MEDIUM' 'Enable EB log streaming.' }
        return R-Skip "Could not query recent events: $($r.Stderr)"
    }
    $events = @($r.Json.events)
    if ($events.Count -gt 0) { return R-Pass "$($events.Count) log event(s) in the last $RecentLogMinutes min on eb-engine." }
    return R-Info "No eb-engine events in the last $RecentLogMinutes min (may simply be idle traffic)."
}

# =============================================================================
# SECTION 5 - DATABASE HEALTH
# =============================================================================
Write-Phase 'SECTION 5: DATABASE HEALTH'

Invoke-Check -Section '5' -Name 'PostgreSQL engine & version' -Weight 1 -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS instance unavailable.' }
    return R-Pass "engine=$($db.Engine) version=$($db.EngineVersion)"
}

Invoke-Check -Section '5' -Name 'Multi-AZ failover capability' -Weight 2 -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS instance unavailable.' }
    if ($db.MultiAZ) { return R-Pass 'RDS is Multi-AZ (automatic failover available).' }
    return R-Warn 'RDS is single-AZ (no automatic failover).' 'HIGH' 'Enable Multi-AZ on the production database for high availability.'
}

Invoke-Check -Section '5' -Name 'Storage usage (allocated / max)' -Weight 1 -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS instance unavailable.' }
    $alloc = [int]$db.AllocatedStorage
    $max = if ($db.PSObject.Properties.Name -contains 'MaxAllocatedStorage' -and $db.MaxAllocatedStorage) { [int]$db.MaxAllocatedStorage } else { 0 }
    $free = $null
    $end = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $start = (Get-Date).ToUniversalTime().AddHours(-1).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $cw = Invoke-AwsRead -What 'cw FreeStorageSpace' cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name FreeStorageSpace `
        --dimensions "Name=DBInstanceIdentifier,Value=$RdsInstanceId" --start-time $start --end-time $end --period 300 --statistics Average --output json
    if ($cw.Ok -and $cw.Json -and @($cw.Json.Datapoints).Count -gt 0) {
        $latest = @($cw.Json.Datapoints | Sort-Object { [datetime]$_.Timestamp } -Descending)[0]
        $free = [math]::Round(($latest.Average / 1GB), 2)
    }
    $maxTxt = if ($max -gt 0) { "$max GB (autoscaling)" } else { 'no autoscaling cap' }
    $freeTxt = if ($null -ne $free) { "; free ~${free} GB" } else { '' }
    return R-Pass "allocated=$alloc GB; max=$maxTxt$freeTxt"
}

Invoke-Check -Section '5' -Name 'Backups (retention & last restorable time)' -Weight 2 -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS instance unavailable.' }
    $retention = [int]$db.BackupRetentionPeriod
    $lrt = if ($db.PSObject.Properties.Name -contains 'LatestRestorableTime') { $db.LatestRestorableTime } else { $null }
    if ($retention -ge 1) { return R-Pass "automated backups on: retention=${retention}d; latest restorable=$lrt" }
    return R-Fail 'Automated backups are DISABLED (retention=0).' 'HIGH' 'Set a backup retention period (e.g. 7 days) on the production DB.'
}

Invoke-Check -Section '5' -Name "Production user count (expect $ExpectedUserCount)" -Weight 1 -Test {
    if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
        return R-Info "psql not on PATH; user-count check requires a PostgreSQL client + credentials. Verify manually that there are $ExpectedUserCount users."
    }
    $conn = $env:DATABASE_URL
    if (-not $conn) {
        $ssm = Invoke-AwsRead -What 'ssm get DATABASE_URL' ssm get-parameter --name "$SsmPrefix/DATABASE_URL" --with-decryption --output json
        if ($ssm.Ok -and $ssm.Json) { $conn = $ssm.Json.Parameter.Value }
    }
    if (-not $conn) { return R-Info 'No DATABASE_URL available (env or SSM); skipping live user-count query. Verify manually.' }
    try {
        $count = (& psql $conn -t -A -c 'SELECT count(*) FROM users;' 2>&1).Trim()
        if ($count -match '^\d+$') {
            if ([int]$count -eq $ExpectedUserCount) { return R-Pass "users table has $count rows (matches expected $ExpectedUserCount)." }
            return R-Warn "users table has $count rows (expected $ExpectedUserCount)." 'LOW' 'Confirm the expected number of production users.'
        }
        return R-Info "Could not parse user count from psql output: $count"
    } catch { return R-Info "psql query failed: $($_.Exception.Message)" }
}

Invoke-Check -Section '5' -Name 'Database connections (CloudWatch)' -Weight 1 -Test {
    $end = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $start = (Get-Date).ToUniversalTime().AddMinutes(-15).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $cw = Invoke-AwsRead -What 'cw DatabaseConnections' cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name DatabaseConnections `
        --dimensions "Name=DBInstanceIdentifier,Value=$RdsInstanceId" --start-time $start --end-time $end --period 300 --statistics Average Maximum --output json
    if ($cw.Ok -and $cw.Json -and @($cw.Json.Datapoints).Count -gt 0) {
        $latest = @($cw.Json.Datapoints | Sort-Object { [datetime]$_.Timestamp } -Descending)[0]
        return R-Pass ("active connections (last 15m): avg={0:N1} max={1:N0}" -f $latest.Average, $latest.Maximum)
    }
    return R-Info 'No DatabaseConnections datapoints in the last 15 min (idle or metric unavailable).'
}

# =============================================================================
# SECTION 6 - APPLICATION TESTS
# =============================================================================
Write-Phase 'SECTION 6: APPLICATION TESTS'

Invoke-Check -Section '6' -Name 'Frontend loads (HTML document)' -Weight 2 -Test {
    $p = Invoke-Probe -Url $FrontendUrl -TimeoutSec 20
    if (-not $p.Ok2xx) {
        if ($p.Reachable) { return R-Fail "Frontend returned HTTP $($p.Code)." 'HIGH' 'See Section 2 connectivity remediation.' }
        return R-Fail "Frontend unreachable: $($p.Error)" 'HIGH' 'See Section 2 connectivity remediation.'
    }
    $hasHtml = ($p.Body -match '<html' -or $p.Body -match '<!doctype' -or $p.Body -match '<div id="root"')
    if ($hasHtml) { return R-Pass 'Frontend returned an HTML document (SPA shell present).' }
    return R-Warn 'Frontend returned 200 but no recognizable HTML shell.' 'LOW' 'Confirm the SPA index.html is served at the root.'
}

Invoke-Check -Section '6' -Name 'Frontend JS console errors' -Weight 1 -Test {
    return R-Info 'Browser console-error detection requires a headless browser (out of scope for this PowerShell audit). Verify manually in DevTools.'
}

Invoke-Check -Section '6' -Name 'API health endpoint reachable' -Weight 3 -Test {
    $candidates = @(
        "https://$ApiHost/health",
        "https://$ApiHost/api/health",
        "https://$ApiHost/healthz",
        "$CloudFrontUrl" + 'health',
        "$CloudFrontUrl" + 'api/health'
    )
    $tried = @()
    foreach ($u in $candidates) {
        $p = Invoke-Probe -Url $u -TimeoutSec 15
        $tried += "$u=$(if ($p.Reachable) { 'HTTP ' + $p.Code } else { 'unreachable' })"
        if ($p.Ok2xx) { return R-Pass "API health OK at $u (HTTP $($p.Code))." $tried }
    }
    return R-Warn "No API health endpoint returned 2xx. Tried: $($tried -join '; ')" 'HIGH' 'Confirm the backend exposes a health route and CloudFront routes /api or the api host to it.'
}

Invoke-Check -Section '6' -Name 'Database connectivity (via API health)' -Weight 2 -Test {
    $candidates = @("https://$ApiHost/health", "$CloudFrontUrl" + 'health', "$CloudFrontUrl" + 'api/health')
    foreach ($u in $candidates) {
        $p = Invoke-Probe -Url $u -TimeoutSec 15
        if ($p.Ok2xx -and $p.Body) {
            if ($p.Body -match '"db"\s*:\s*"?(ok|up|connected|healthy|true)"?' -or $p.Body -match 'database.*(ok|up|healthy|connected)') {
                return R-Pass "API health reports database connectivity OK ($u)."
            }
            return R-Info "API health reachable at $u but did not explicitly report DB status."
        }
    }
    return R-Info 'Could not infer DB connectivity from an API health payload; verify via backend logs.'
}

Invoke-Check -Section '6' -Name 'SSM Parameter Store accessible (secrets)' -Weight 2 -Test {
    $r = Invoke-AwsRead -What 'ssm get-parameters-by-path' ssm get-parameters-by-path --path $SsmPrefix --recursive --max-items 5 --output json
    if ($r.Ok -and $r.Json) {
        $count = @($r.Json.Parameters).Count
        if ($count -gt 0) { return R-Pass "SSM path '$SsmPrefix' accessible; $count+ parameter(s) present." }
        return R-Warn "SSM path '$SsmPrefix' accessible but contains no parameters." 'MEDIUM' 'Confirm production secrets are stored under this path.'
    }
    if (Test-AccessDenied $r.Stderr) { return R-Warn "SSM path '$SsmPrefix' access denied to this identity." 'MEDIUM' 'Grant ssm:GetParametersByPath on this path.' }
    return R-Warn "Could not read SSM path '$SsmPrefix': $($r.Stderr)" 'MEDIUM' 'Verify the parameter path and SSM read permission.'
}

Invoke-Check -Section '6' -Name 'S3 audio bucket accessible (read)' -Weight 2 -Test {
    $r = Invoke-AwsRead -What 's3api list-objects-v2 (audio)' s3api list-objects-v2 --bucket $AudioBucket --max-items 1 --output json
    $readOk = $false
    $msg = ''
    if ($r.Ok) { $readOk = $true; $msg = "read OK (list-objects on '$AudioBucket')." }
    elseif (Test-AccessDenied $r.Stderr) { return R-Warn "audio bucket '$AudioBucket' read access denied." 'HIGH' 'Grant s3:ListBucket/GetObject on the audio bucket to the backend role.' }
    else { return R-Fail "audio bucket '$AudioBucket' not readable: $($r.Stderr)" 'HIGH' 'Confirm the bucket exists and the identity can read it.' }

    if (-not $AllowWriteTests) { return R-Pass "$msg Write test skipped (pass -AllowWriteTests to round-trip a temp object)." }

    $key = "validation/_healthcheck-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).txt"
    $tmp = Join-Path $ArtifactDir '_s3-write-probe.txt'
    "anot-health validation probe $(Get-Date -Format o)" | Out-File -FilePath $tmp -Encoding ascii
    $put = Invoke-AwsRead -What 's3api put-object (probe)' s3api put-object --bucket $AudioBucket --key $key --body $tmp --output json
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    if (-not $put.Ok) {
        if (Test-AccessDenied $put.Stderr) { return R-Warn "$msg Write DENIED to '$AudioBucket'." 'MEDIUM' 'Grant s3:PutObject if the backend must upload audio.' }
        return R-Warn "$msg Write failed: $($put.Stderr)" 'LOW' 'Investigate the S3 put failure.'
    }
    Invoke-AwsRead -What 's3api delete-object (probe)' s3api delete-object --bucket $AudioBucket --key $key | Out-Null
    return R-Pass "$msg Write round-trip OK (temp object created + deleted)."
}

# =============================================================================
# SECTION 7 - AUTO-SCALING VALIDATION
# =============================================================================
Write-Phase 'SECTION 7: AUTO-SCALING VALIDATION'

Invoke-Check -Section '7' -Name 'Scaling policies exist (scale-up / scale-down)' -Weight 2 -Test {
    if (-not $script:AsgName) { return R-Skip 'ASG not resolved; cannot read scaling policies.' }
    $r = Invoke-AwsRead -What 'autoscaling describe-policies' autoscaling describe-policies --auto-scaling-group-name $script:AsgName --output json
    if (-not $r.Ok) { return R-Warn "Could not read scaling policies: $($r.Stderr)" 'MEDIUM' 'Verify autoscaling:DescribePolicies permission.' }
    $names = @($r.Json.ScalingPolicies | ForEach-Object { $_.PolicyName })
    $types = @($r.Json.ScalingPolicies | ForEach-Object { "$($_.PolicyName)=$($_.PolicyType)" })
    $haveUp = ($names -contains $ScaleUpPolicy)
    $haveDown = ($names -contains $ScaleDownPolicy)
    if ($haveUp -and $haveDown) { return R-Pass "scale-up and scale-down policies present: $($types -join ', ')" $types }
    if ($names.Count -gt 0) { return R-Warn "expected '$ScaleUpPolicy' + '$ScaleDownPolicy'; found: $($names -join ', ')." 'MEDIUM' 'Create the CPU scaling policies (scripts/enable-eb-autoscaling.ps1).' }
    return R-Warn 'No scaling policies attached to the ASG.' 'MEDIUM' 'Create scale-up/scale-down policies (scripts/enable-eb-autoscaling.ps1).'
}

Invoke-Check -Section '7' -Name 'CloudWatch alarms wired to scaling policies' -Weight 1 -Test {
    $r = Invoke-AwsRead -What 'describe-alarms (scaling)' cloudwatch describe-alarms --alarm-names $CpuHighAlarm $CpuLowAlarm --output json
    if (-not $r.Ok) { return R-Warn "Could not read alarms: $($r.Stderr)" 'MEDIUM' 'Verify cloudwatch:DescribeAlarms permission.' }
    $alarms = @($r.Json.MetricAlarms)
    if ($alarms.Count -eq 0) { return R-Warn 'No CPU scaling alarms found.' 'MEDIUM' 'Create the scaling alarms (scripts/enable-eb-autoscaling.ps1).' }
    $withActions = @($alarms | Where-Object { @($_.AlarmActions).Count -gt 0 })
    $desc = @($alarms | ForEach-Object { "$($_.AlarmName) [$($_.ComparisonOperator) $($_.Threshold), state=$($_.StateValue)]" })
    if ($withActions.Count -eq $alarms.Count) { return R-Pass "alarms wired to actions: $($desc -join '; ')" }
    return R-Warn "some alarms have no actions: $($desc -join '; ')" 'MEDIUM' 'Ensure each alarm triggers its scaling policy ARN.'
}

Invoke-Check -Section '7' -Name 'Scaling metric type' -Weight 1 -Test {
    if (-not $script:AsgName) { return R-Skip 'ASG not resolved.' }
    $r = Invoke-AwsRead -What 'describe-policies (type)' autoscaling describe-policies --auto-scaling-group-name $script:AsgName --output json
    if (-not $r.Ok) { return R-Skip "Could not read policies: $($r.Stderr)" }
    $pols = @($r.Json.ScalingPolicies)
    if ($pols.Count -eq 0) { return R-Info 'No scaling policies to classify.' }
    $hasTarget = @($pols | Where-Object { $_.PolicyType -eq 'TargetTrackingScaling' }).Count -gt 0
    $hasSimple = @($pols | Where-Object { $_.PolicyType -eq 'SimpleScaling' }).Count -gt 0
    if ($hasTarget) { return R-Pass 'target-tracking scaling policy present (metric-driven auto-scaling).' }
    if ($hasSimple) { return R-Info 'using SimpleScaling policies driven by CloudWatch CPU alarms (no target-tracking).' }
    return R-Info "policy types: $(@($pols | ForEach-Object { $_.PolicyType }) -join ', ')"
}

Invoke-Check -Section '7' -Name 'Recent scaling activities' -Weight 1 -Test {
    if (-not $script:AsgName) { return R-Skip 'ASG not resolved.' }
    $r = Invoke-AwsRead -What 'describe-scaling-activities' autoscaling describe-scaling-activities --auto-scaling-group-name $script:AsgName --max-items 5 --output json
    if (-not $r.Ok) { return R-Skip "Could not read scaling activities: $($r.Stderr)" }
    $acts = @($r.Json.Activities)
    if ($acts.Count -eq 0) { return R-Info 'No recent scaling activities (steady state).' }
    $latest = $acts[0]
    return R-Pass "latest scaling activity: $($latest.Description) [$($latest.StatusCode)] @ $($latest.StartTime)"
}

# =============================================================================
# SECTION 8 + 9 - ISSUES, SCORE, GO/NO-GO  (computed from collected results)
# =============================================================================
Write-Phase 'SECTION 8: IDENTIFIED ISSUES'

$severityOrder = @{ 'CRITICAL' = 0; 'HIGH' = 1; 'MEDIUM' = 2; 'LOW' = 3; '' = 4 }
$issues = @($script:Results | Where-Object { $_.Status -eq 'FAIL' -or $_.Status -eq 'WARN' } |
    Sort-Object @{ Expression = { $severityOrder[$_.Severity] } }, Section)

if ($DryRun) {
    Write-Step 'Dry-run: no checks were executed, so no issues were collected.'
} elseif ($issues.Count -eq 0) {
    Write-Host '  [OK] No issues detected.' -ForegroundColor Green
} else {
    foreach ($grp in @('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', '')) {
        $g = @($issues | Where-Object { $_.Severity -eq $grp })
        if ($g.Count -eq 0) { continue }
        $label = if ($grp) { $grp } else { 'UNCLASSIFIED' }
        $col = switch ($grp) { 'CRITICAL' { 'Red' } 'HIGH' { 'Red' } 'MEDIUM' { 'Yellow' } 'LOW' { 'DarkYellow' } default { 'Gray' } }
        Write-Host ''
        Write-Host "  $label ($($g.Count)):" -ForegroundColor $col
        foreach ($i in $g) {
            Write-Host "    - [$($i.Status)] $($i.SectionName) / $($i.Name)" -ForegroundColor $col
            if ($i.Detail) { Write-Host "        $($i.Detail)" -ForegroundColor DarkGray }
            if ($i.Remediation) { Write-Host "        fix: $($i.Remediation)" -ForegroundColor DarkGray }
        }
    }
}

Write-Phase 'SECTION 9: PRODUCTION READINESS SCORE'

$scored = @($script:Results | Where-Object { $_.Status -in 'PASS', 'WARN', 'FAIL' })
$passCount = @($script:Results | Where-Object { $_.Status -eq 'PASS' }).Count
$warnCount = @($script:Results | Where-Object { $_.Status -eq 'WARN' }).Count
$failCount = @($script:Results | Where-Object { $_.Status -eq 'FAIL' }).Count
$infoCount = @($script:Results | Where-Object { $_.Status -eq 'INFO' }).Count
$skipCount = @($script:Results | Where-Object { $_.Status -eq 'SKIP' }).Count

$score = 0
$totalWeight = 0.0
$gotWeight = 0.0
foreach ($r in $scored) {
    $w = [double]$r.Weight
    $totalWeight += $w
    if ($r.Status -eq 'PASS') { $gotWeight += $w }
    elseif ($r.Status -eq 'WARN') { $gotWeight += ($w * 0.5) }
}
if ($totalWeight -gt 0) { $score = [int][math]::Round(100.0 * $gotWeight / $totalWeight) }

$blockers = @($script:Results | Where-Object { $_.Status -eq 'FAIL' -and ($_.Severity -eq 'CRITICAL' -or $_.Severity -eq 'HIGH') })
$deferred = @($script:Results | Where-Object { ($_.Status -eq 'WARN') -or ($_.Status -eq 'FAIL' -and ($_.Severity -eq 'MEDIUM' -or $_.Severity -eq 'LOW')) })
$criticalBlockers = @($blockers | Where-Object { $_.Severity -eq 'CRITICAL' })

if ($DryRun) {
    $decision = 'N/A (dry-run)'
    $decisionColor = 'DarkGray'
} elseif ($criticalBlockers.Count -gt 0) {
    $decision = 'NO-GO'
    $decisionColor = 'Red'
} elseif ($blockers.Count -gt 0) {
    $decision = 'CONDITIONAL GO (resolve HIGH blockers)'
    $decisionColor = 'Yellow'
} elseif ($score -ge 80) {
    $decision = 'GO'
    $decisionColor = 'Green'
} else {
    $decision = 'CONDITIONAL GO (address warnings)'
    $decisionColor = 'Yellow'
}

Write-Host ''
Write-Host "  Checks: PASS=$passCount  WARN=$warnCount  FAIL=$failCount  INFO=$infoCount  SKIP=$skipCount" -ForegroundColor Gray
Write-Host "  Readiness score: $score / 100" -ForegroundColor $(if ($score -ge 80) { 'Green' } elseif ($score -ge 60) { 'Yellow' } else { 'Red' })
Write-Host "  Blockers: $($blockers.Count) (critical: $($criticalBlockers.Count))   Deferred: $($deferred.Count)" -ForegroundColor Gray
Write-Host "  DECISION: $decision" -ForegroundColor $decisionColor

if ($blockers.Count -gt 0) {
    Write-Host ''
    Write-Host '  BLOCKERS (must fix before go-live):' -ForegroundColor Red
    foreach ($b in $blockers) { Write-Host "    - [$($b.Severity)] $($b.SectionName) / $($b.Name): $($b.Detail)" -ForegroundColor Red }
}

# =============================================================================
# OUTPUT: JSON + HTML
# =============================================================================
Write-Phase 'OUTPUT: writing JSON + HTML reports'

# ---- JSON ----
$jsonObj = [ordered]@{
    generatedAt = $StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    finishedAt  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    mode        = if ($DryRun) { 'dry-run' } else { 'live' }
    account     = $AwsAccountId
    region      = $Region
    identity    = $IdentityArn
    summary     = [ordered]@{
        score             = $score
        decision          = $decision
        pass              = $passCount
        warn              = $warnCount
        fail              = $failCount
        info              = $infoCount
        skip              = $skipCount
        blockerCount      = $blockers.Count
        criticalBlockers  = $criticalBlockers.Count
        deferredCount     = $deferred.Count
    }
    blockers = @($blockers | ForEach-Object { [ordered]@{ section = $_.SectionName; name = $_.Name; severity = $_.Severity; detail = $_.Detail; remediation = $_.Remediation } })
    results  = @($script:Results | ForEach-Object {
        [ordered]@{
            timestamp   = $_.Timestamp
            section     = $_.Section
            sectionName = $_.SectionName
            name        = $_.Name
            status      = $_.Status
            severity    = $_.Severity
            detail      = $_.Detail
            remediation = $_.Remediation
            weight      = $_.Weight
        }
    })
}
$jsonText = $jsonObj | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($JsonReport, $jsonText, [System.Text.UTF8Encoding]::new($false))
Write-Step "JSON results -> $JsonReport"

# ---- HTML ----
function ConvertTo-HtmlText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    return $Text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

$statusBadge = {
    param($s)
    $cls = switch ($s) { 'PASS' { 'pass' } 'WARN' { 'warn' } 'FAIL' { 'fail' } 'INFO' { 'info' } 'SKIP' { 'skip' } default { 'info' } }
    "<span class='badge $cls'>$s</span>"
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<!doctype html><html lang="en"><head><meta charset="utf-8">')
[void]$sb.AppendLine('<meta name="viewport" content="width=device-width, initial-scale=1">')
[void]$sb.AppendLine('<title>Anot Health - Production Validation Report</title>')
[void]$sb.AppendLine(@'
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#0f1419;color:#e6e6e6}
.wrap{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:18px;margin:28px 0 10px;border-bottom:1px solid #2a3340;padding-bottom:6px}
.meta{color:#9aa7b4;font-size:13px;margin-bottom:18px}
.scorecard{display:flex;flex-wrap:wrap;gap:16px;margin:18px 0}
.card{background:#161d27;border:1px solid #2a3340;border-radius:10px;padding:16px 20px;min-width:150px}
.card .num{font-size:30px;font-weight:700}
.card .lbl{color:#9aa7b4;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.decision{font-size:22px;font-weight:700;padding:10px 16px;border-radius:10px;display:inline-block}
.go{background:#0f3d24;color:#5ee08a;border:1px solid #1d6b41}
.cond{background:#3d340f;color:#e0c95e;border:1px solid #6b5d1d}
.nogo{background:#3d0f0f;color:#e05e5e;border:1px solid #6b1d1d}
.na{background:#23262b;color:#9aa7b4;border:1px solid #3a3f47}
table{border-collapse:collapse;width:100%;margin:6px 0 12px;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #232c38;vertical-align:top}
th{color:#9aa7b4;font-weight:600;font-size:12px;text-transform:uppercase}
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap}
.badge.pass{background:#0f3d24;color:#5ee08a}
.badge.warn{background:#3d340f;color:#e0c95e}
.badge.fail{background:#3d0f0f;color:#e05e5e}
.badge.info{background:#13314d;color:#5eb6e0}
.badge.skip{background:#23262b;color:#9aa7b4}
.sev{font-size:11px;font-weight:700}
.sev.CRITICAL,.sev.HIGH{color:#e05e5e}
.sev.MEDIUM{color:#e0c95e}
.sev.LOW{color:#c0a85e}
.detail{color:#c2ccd6}
.rem{color:#9aa7b4;font-size:13px}
.muted{color:#9aa7b4}
</style>
'@)
[void]$sb.AppendLine('</head><body><div class="wrap">')
[void]$sb.AppendLine('<h1>Anot Health - Production Validation Report</h1>')
$modeTxt = if ($DryRun) { 'DRY-RUN (plan only)' } else { 'LIVE' }
[void]$sb.AppendLine("<div class='meta'>Generated $(ConvertTo-HtmlText $jsonObj.generatedAt) &middot; mode <b>$modeTxt</b> &middot; account $AwsAccountId &middot; region $Region &middot; identity $(ConvertTo-HtmlText $IdentityArn)</div>")

$decCls = switch -Regex ($decision) { 'NO-GO' { 'nogo' } 'CONDITIONAL' { 'cond' } '^GO$' { 'go' } default { 'na' } }
[void]$sb.AppendLine('<div class="scorecard">')
[void]$sb.AppendLine("<div class='card'><div class='num'>$score</div><div class='lbl'>Score / 100</div></div>")
[void]$sb.AppendLine("<div class='card'><div class='num' style='color:#5ee08a'>$passCount</div><div class='lbl'>Pass</div></div>")
[void]$sb.AppendLine("<div class='card'><div class='num' style='color:#e0c95e'>$warnCount</div><div class='lbl'>Warn</div></div>")
[void]$sb.AppendLine("<div class='card'><div class='num' style='color:#e05e5e'>$failCount</div><div class='lbl'>Fail</div></div>")
[void]$sb.AppendLine("<div class='card'><div class='num'>$($blockers.Count)</div><div class='lbl'>Blockers</div></div>")
[void]$sb.AppendLine('</div>')
[void]$sb.AppendLine("<p><span class='decision $decCls'>DECISION: $(ConvertTo-HtmlText $decision)</span></p>")

# Blockers
if ($blockers.Count -gt 0) {
    [void]$sb.AppendLine('<h2>Blockers (must fix before go-live)</h2><table><tr><th>Severity</th><th>Section</th><th>Check</th><th>Detail</th><th>Remediation</th></tr>')
    foreach ($b in $blockers) {
        [void]$sb.AppendLine("<tr><td class='sev $($b.Severity)'>$($b.Severity)</td><td>$(ConvertTo-HtmlText $b.SectionName)</td><td>$(ConvertTo-HtmlText $b.Name)</td><td class='detail'>$(ConvertTo-HtmlText $b.Detail)</td><td class='rem'>$(ConvertTo-HtmlText $b.Remediation)</td></tr>")
    }
    [void]$sb.AppendLine('</table>')
}

# Issues
if ($issues.Count -gt 0) {
    [void]$sb.AppendLine('<h2>Identified Issues</h2><table><tr><th>Severity</th><th>Status</th><th>Section</th><th>Check</th><th>Detail</th><th>Remediation</th></tr>')
    foreach ($i in $issues) {
        $sevTxt = if ($i.Severity) { $i.Severity } else { '-' }
        [void]$sb.AppendLine("<tr><td class='sev $($i.Severity)'>$sevTxt</td><td>$(& $statusBadge $i.Status)</td><td>$(ConvertTo-HtmlText $i.SectionName)</td><td>$(ConvertTo-HtmlText $i.Name)</td><td class='detail'>$(ConvertTo-HtmlText $i.Detail)</td><td class='rem'>$(ConvertTo-HtmlText $i.Remediation)</td></tr>")
    }
    [void]$sb.AppendLine('</table>')
}

# Per-section detail
foreach ($key in $SectionTitles.Keys) {
    $secResults = @($script:Results | Where-Object { $_.Section -eq $key })
    if ($secResults.Count -eq 0) { continue }
    [void]$sb.AppendLine("<h2>Section $key &mdash; $(ConvertTo-HtmlText $SectionTitles[$key])</h2>")
    [void]$sb.AppendLine('<table><tr><th>Status</th><th>Check</th><th>Detail</th><th>Severity</th></tr>')
    foreach ($r in $secResults) {
        $sevTxt = if ($r.Severity) { "<span class='sev $($r.Severity)'>$($r.Severity)</span>" } else { '<span class="muted">-</span>' }
        [void]$sb.AppendLine("<tr><td>$(& $statusBadge $r.Status)</td><td>$(ConvertTo-HtmlText $r.Name)</td><td class='detail'>$(ConvertTo-HtmlText $r.Detail)</td><td>$sevTxt</td></tr>")
    }
    [void]$sb.AppendLine('</table>')
}

[void]$sb.AppendLine("<p class='muted'>Report generated by validate-production.ps1 &middot; $(ConvertTo-HtmlText ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')))</p>")
[void]$sb.AppendLine('</div></body></html>')

[System.IO.File]::WriteAllText($HtmlReport, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Step "HTML report -> $HtmlReport"

# =============================================================================
# DONE
# =============================================================================
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor $decisionColor
if ($DryRun) {
    Write-Host '  DRY-RUN COMPLETE: planned checks enumerated; reports written. Re-run with -Live to execute.' -ForegroundColor DarkGray
} else {
    Write-Host "  VALIDATION COMPLETE: score $score/100  |  decision: $decision" -ForegroundColor $decisionColor
}
Write-Host ('=' * 78) -ForegroundColor $decisionColor
Write-Host "  HTML : $HtmlReport" -ForegroundColor Gray
Write-Host "  JSON : $JsonReport" -ForegroundColor Gray
Write-Host ''

# Exit non-zero on a NO-GO so CI/automation can gate on it.
if (-not $DryRun -and $criticalBlockers.Count -gt 0) { exit 2 }
exit 0
