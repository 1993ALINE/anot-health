<#
================================================================================
 audit-complete-platform.ps1  -  FULL platform audit for the Anot Health stack
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHAT THIS SCRIPT DOES:
   Runs a single, broad, READ-ONLY audit across the ENTIRE platform - source
   code, dependencies, security posture, AWS infrastructure, operations,
   compliance, and live application endpoints - and produces:
     * Console : color-coded, timestamped progress + a final summary.
     * JSON    : structured findings at dist/audit-complete-results.json
     * HTML    : a full audit report at dist/audit-complete-report.html

   It NEVER mutates anything. Every AWS call is a Describe/Get/List, every HTTP
   call is a GET, every source check only reads files. The companion script
   fix-all-bugs.ps1 consumes the JSON and applies (or prints) remediations.

 THE SIX SECTIONS (mirror the platform audit checklist):
   1. CODE QUALITY      Frontend + backend source scans, dependency health,
                        endpoint/auth coverage, error handling, repo hygiene.
   2. SECURITY          Secrets, CORS, rate limiting, headers, TLS, WAF, IAM,
                        S3 encryption + public-access-block, RDS encryption.
   3. OPERATIONS        Log groups, retention, scaling alarms, RDS monitoring,
                        backups, recent log activity.
   4. INFRASTRUCTURE    EB, RDS, CloudFront, S3, security groups, ASG, tagging.
   5. COMPLIANCE        HIPAA artifacts, audit-logging code, PII encryption,
                        log scrubbing, data-retention policy.
   6. APPLICATION       Frontend load, API health, DNS, end-to-end reachability.

 MODES:
   -DryRun   Read-only PLAN: enumerates every check it WOULD run and writes the
             report/JSON, but performs NO AWS or network calls. Local source
             scans STILL run (they are always safe). Safe anywhere.
   -Live     Executes every read-only check against the source tree, AWS, and
             the public endpoints. (Default when neither switch is given.)
   -SkipAws  Run only the local source/dependency/compliance checks (no AWS).
   -SkipNet  Skip the live HTTP/DNS/TLS probes.

 EACH FINDING CARRIES (for the fixer + the report):
   Severity     CRITICAL / HIGH / MEDIUM / LOW
   RootCause    why the finding exists
   Impact       what it means for production
   Remediation  the recommended fix
   FixId        stable key the auto-fixer (fix-all-bugs.ps1) keys off of
   Auto         whether fix-all-bugs.ps1 can remediate it automatically
   Manual       manual steps when no automated fix exists

 USAGE:
   powershell -File scripts/audit-complete-platform.ps1 -Live
   powershell -File scripts/audit-complete-platform.ps1 -DryRun
   powershell -File scripts/audit-complete-platform.ps1 -Live -SkipAws
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Live,
    [switch]$SkipAws,
    [switch]$SkipNet,
    [int]$ExpectedRetentionDays = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId   = '625242092266'
$Region         = 'ap-southeast-1'
$GlobalRegion   = 'us-east-1'

# Elastic Beanstalk
$EbAppName      = 'anot-backend'
$EbEnvName      = 'anot-backend-prod'

# RDS
$RdsInstanceId  = 'anot-postgres'

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

# Logging
$EbLogGroupPrefix = "/aws/elasticbeanstalk/$EbEnvName"
$RdsOsLogGroup    = 'RDSOSMetrics'

# Auto-scaling alarms
$CpuHighAlarm   = "$EbEnvName-cpu-high"
$CpuLowAlarm    = "$EbEnvName-cpu-low"

# IAM ops user
$OpsUserName    = 'anot-ops'
$OpsPolicyName  = 'anot-ops-prod-policy'

# ---- Repo layout. This script lives in <backend>/scripts. The backend root is
#      one level up; the workspace root is three levels up (anot-health/). ----
$ScriptDir    = $PSScriptRoot
$BackendDir   = Split-Path -Parent $ScriptDir
$WorkspaceDir = $BackendDir
for ($i = 0; $i -lt 4; $i++) {
    $candidate = (Resolve-Path (Join-Path $WorkspaceDir '..')).Path
    if (Test-Path (Join-Path $candidate 'anot-frontend-main')) { $WorkspaceDir = $candidate; break }
    $WorkspaceDir = $candidate
}
$FrontendDir  = $null
foreach ($p in @(
    (Join-Path $WorkspaceDir 'anot-frontend-main\anot-frontend-main'),
    (Join-Path $WorkspaceDir 'anot-frontend-main')
)) { if (Test-Path $p) { $FrontendDir = $p; break } }

$BackendSrc   = Join-Path $BackendDir 'src'
$FrontendSrc  = if ($FrontendDir) { Join-Path $FrontendDir 'src' } else { $null }

$ArtifactDir  = Join-Path $BackendDir 'dist'
$HtmlReport   = Join-Path $ArtifactDir 'audit-complete-report.html'
$JsonReport   = Join-Path $ArtifactDir 'audit-complete-results.json'
$StartTime    = Get-Date

# Default to LIVE if the operator gave neither switch.
if (-not $DryRun -and -not $Live) { $Live = $true }
if ($DryRun) { $Live = $false }

$env:AWS_DEFAULT_REGION = $Region
$env:AWS_PAGER = ''
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$SectionTitles = [ordered]@{
    '1' = 'CODE QUALITY'
    '2' = 'SECURITY'
    '3' = 'OPERATIONS'
    '4' = 'INFRASTRUCTURE'
    '5' = 'COMPLIANCE'
    '6' = 'APPLICATION FUNCTIONALITY'
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
function Add-Result {
    param(
        [string]$Section,
        [string]$Name,
        [ValidateSet('PASS','WARN','FAIL','INFO','SKIP')] [string]$Status,
        [string]$Detail = '',
        [ValidateSet('CRITICAL','HIGH','MEDIUM','LOW','')] [string]$Severity = '',
        [string]$RootCause = '',
        [string]$Impact = '',
        [string]$Remediation = '',
        [string]$FixId = '',
        [bool]$Auto = $false,
        [string]$Manual = '',
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
        RootCause   = $RootCause
        Impact      = $Impact
        Detail      = $Detail
        Remediation = $Remediation
        FixId       = $FixId
        Auto        = $Auto
        Manual      = $Manual
        Weight      = $Weight
        Data        = $Data
    }
    $script:Results.Add($rec)

    $color = Get-StatusColor -Status $Status
    $sevTxt = if ($Severity) { " ($Severity)" } else { '' }
    Write-Host ("  [{0}] [{1,-4}]{2} {3}" -f $stamp, $Status, $sevTxt, $Name) -ForegroundColor $color
    if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
    if ($Remediation -and ($Status -eq 'FAIL' -or $Status -eq 'WARN')) {
        $autoTxt = if ($Auto) { ' [auto-fixable]' } else { ' [manual]' }
        Write-Host "         fix${autoTxt}: $Remediation" -ForegroundColor DarkYellow
    }
}

# Constructors returning the result hashtable that each check scriptblock yields.
function R-Pass { param([string]$Detail,[object]$Data=$null) @{ Status='PASS'; Detail=$Detail; Data=$Data } }
function R-Info { param([string]$Detail,[object]$Data=$null) @{ Status='INFO'; Detail=$Detail; Data=$Data } }
function R-Skip { param([string]$Detail,[object]$Data=$null) @{ Status='SKIP'; Detail=$Detail; Data=$Data } }
function R-Warn {
    param([string]$Detail,[string]$Severity='MEDIUM',[string]$Remediation='',[string]$FixId='',[bool]$Auto=$false,[string]$RootCause='',[string]$Impact='',[string]$Manual='',[object]$Data=$null)
    @{ Status='WARN'; Detail=$Detail; Severity=$Severity; Remediation=$Remediation; FixId=$FixId; Auto=$Auto; RootCause=$RootCause; Impact=$Impact; Manual=$Manual; Data=$Data }
}
function R-Fail {
    param([string]$Detail,[string]$Severity='HIGH',[string]$Remediation='',[string]$FixId='',[bool]$Auto=$false,[string]$RootCause='',[string]$Impact='',[string]$Manual='',[object]$Data=$null)
    @{ Status='FAIL'; Detail=$Detail; Severity=$Severity; Remediation=$Remediation; FixId=$FixId; Auto=$Auto; RootCause=$RootCause; Impact=$Impact; Manual=$Manual; Data=$Data }
}

# Run one check. -RequiresAws / -RequiresNet checks are SKIPPed (not failed) when
# the corresponding capability is disabled or unavailable. In -DryRun, every
# check records a SKIP plan entry instead of executing.
function Invoke-Check {
    param(
        [string]$Section,
        [string]$Name,
        [int]$Weight = 1,
        [switch]$RequiresAws,
        [switch]$RequiresNet,
        [scriptblock]$Test
    )
    if ($DryRun) {
        Add-Result -Section $Section -Name $Name -Status 'SKIP' -Weight $Weight `
            -Detail 'Dry-run: read-only plan only (this check was not executed).'
        return
    }
    if ($RequiresAws -and -not $script:AwsReady) {
        Add-Result -Section $Section -Name $Name -Status 'SKIP' -Weight $Weight `
            -Detail 'AWS not available (no CLI/identity, or -SkipAws). Re-run with AWS access to evaluate.'
        return
    }
    if ($RequiresNet -and $SkipNet) {
        Add-Result -Section $Section -Name $Name -Status 'SKIP' -Weight $Weight `
            -Detail 'Network probes disabled (-SkipNet).'
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
            $get = { param($k,$d) if ($item.ContainsKey($k)) { $item[$k] } else { $d } }
            Add-Result -Section $Section -Name (& $get 'Name' $Name) -Status $item.Status -Weight $Weight `
                -Detail (& $get 'Detail' '') -Severity (& $get 'Severity' '') `
                -RootCause (& $get 'RootCause' '') -Impact (& $get 'Impact' '') `
                -Remediation (& $get 'Remediation' '') -FixId (& $get 'FixId' '') `
                -Auto ([bool](& $get 'Auto' $false)) -Manual (& $get 'Manual' '') `
                -Data (& $get 'Data' $null)
        }
    }
    catch {
        Add-Result -Section $Section -Name $Name -Status 'FAIL' -Weight $Weight `
            -Detail "Check raised an error: $($_.Exception.Message)" -Severity 'MEDIUM' `
            -Remediation 'Investigate the audit error; a call or probe failed unexpectedly.'
    }
}
#endregion

#region --------------------------- AWS / NET / FS HELPERS --------------------
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
            catch { $code = 9001; $captured = $_.Exception.Message }
            finally { $ErrorActionPreference = $prevEap }

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
                return $result
            }
            if ($attempt -lt $Retries) { Start-Sleep -Seconds $DelaySeconds; continue }
            $result.Ok = $false; $result.Code = $code; $result.Stdout = $stdout; $result.Stderr = $stderr
            return $result
        }
    }
    finally { $env:AWS_DEFAULT_REGION = $prevRegion }
}

function Test-AccessDenied {
    param([string]$Text)
    if (-not $Text) { return $false }
    return ($Text -match 'AccessDenied|UnauthorizedOperation|not authorized|AuthorizationError|is not authorized to perform')
}

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
        $ex = $_.Exception; $resp = $null
        if ($ex.PSObject.Properties.Name -contains 'Response') { $resp = $ex.Response }
        if ($resp) {
            $rec.Reachable = $true
            try { $rec.Code = [int]$resp.StatusCode } catch { $rec.Code = $null }
            if ($rec.Code) { $rec.Ok2xx = ($rec.Code -ge 200 -and $rec.Code -lt 300) }
        } else { $rec.Reachable = $false }
        $rec.Error = $ex.Message
    }
    return $rec
}

function Get-TlsInfo {
    param([string]$HostName, [int]$Port = 443, [int]$TimeoutSec = 10)
    $info = [pscustomobject]@{ Ok = $false; Protocol = $null; Error = $null }
    $tcp = $null; $ssl = $null
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect($HostName, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($TimeoutSec))) { $info.Error = 'connect timeout'; return $info }
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

function Resolve-HostAddresses {
    param([string]$HostName)
    try {
        if (Get-Command Resolve-DnsName -ErrorAction SilentlyContinue) {
            $r = Resolve-DnsName -Name $HostName -ErrorAction Stop
            return @($r | Where-Object { $_.PSObject.Properties.Name -contains 'IPAddress' -and $_.IPAddress } | ForEach-Object { $_.IPAddress })
        }
        return @([System.Net.Dns]::GetHostAddresses($HostName) | ForEach-Object { $_.IPAddressToString })
    }
    catch { return @() }
}

# Read every source file under a root with the given extensions. Returns
# @( @{ Path; Rel; Text } ). Skips node_modules / dist / build dirs.
function Get-SourceFiles {
    param([string]$Root, [string[]]$Extensions = @('.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'))
    if (-not $Root -or -not (Test-Path $Root)) { return @() }
    $files = Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object {
            $Extensions -contains $_.Extension.ToLower() -and
            $_.FullName -notmatch '[\\/](node_modules|dist|build|\.git|coverage|backup-v\d+|temp-extract)[\\/]'
        }
    $out = @()
    foreach ($f in $files) {
        $text = ''
        try { $text = [System.IO.File]::ReadAllText($f.FullName) } catch { $text = '' }
        $out += [pscustomobject]@{
            Path = $f.FullName
            Rel  = $f.FullName.Substring($Root.Length).TrimStart('\','/')
            Text = $text
        }
    }
    return $out
}

# Count regex matches across a set of source files. Returns @{ Count; Files }.
function Measure-Pattern {
    param([object[]]$Files, [string]$Pattern, [string[]]$ExcludeRel = @())
    $count = 0
    $hitFiles = @()
    foreach ($f in $Files) {
        if ($ExcludeRel -and ($ExcludeRel | Where-Object { $f.Rel -like $_ }).Count -gt 0) { continue }
        $m = [regex]::Matches($f.Text, $Pattern)
        if ($m.Count -gt 0) { $count += $m.Count; $hitFiles += $f.Rel }
    }
    return @{ Count = $count; Files = @($hitFiles | Sort-Object -Unique) }
}
#endregion

# ----------------------------- shared caches ---------------------------------
$script:EbEnv  = $null
$script:Rds    = $null
$script:Dist   = $null
$script:WebAcl = $null
$script:AsgName = $null

function Get-EbEnvCached {
    if ($null -ne $script:EbEnv) { return $script:EbEnv }
    $r = Invoke-AwsRead -What 'describe-environments' elasticbeanstalk describe-environments --application-name $EbAppName --environment-names $EbEnvName --output json
    if ($r.Ok -and $r.Json -and @($r.Json.Environments).Count -gt 0) { $script:EbEnv = @($r.Json.Environments)[0] }
    return $script:EbEnv
}
function Get-RdsCached {
    if ($null -ne $script:Rds) { return $script:Rds }
    $r = Invoke-AwsRead -What 'describe-db-instances' rds describe-db-instances --db-instance-identifier $RdsInstanceId --output json
    if ($r.Ok -and $r.Json -and @($r.Json.DBInstances).Count -gt 0) { $script:Rds = @($r.Json.DBInstances)[0] }
    return $script:Rds
}
function Get-DistCached {
    if ($null -ne $script:Dist) { return $script:Dist }
    $r = Invoke-AwsRead -What 'cloudfront get-distribution' -UseRegion $GlobalRegion cloudfront get-distribution --id $DistributionId --output json
    if ($r.Ok -and $r.Json) { $script:Dist = $r.Json.Distribution }
    return $script:Dist
}
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

# =============================================================================
trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  AUDIT-COMPLETE-PLATFORM ABORTED (unexpected error)' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    Write-Host ''
    exit 1
}

# =============================================================================
# PRE-FLIGHT
# =============================================================================
Write-Phase 'PRE-FLIGHT: tooling + identity + repo layout'

if ($DryRun) {
    Write-Step 'DRY-RUN MODE: enumerating planned checks only. No AWS/network calls; source scans skipped.'
} else {
    Write-Step 'LIVE MODE: running read-only audit across source, AWS, and public endpoints.'
}

Write-Diag "backend dir : $BackendDir"
Write-Diag "frontend dir: $(if ($FrontendDir) { $FrontendDir } else { '(not found)' })"
Write-Diag "artifacts   : $ArtifactDir"

$IdentityArn = '(unknown)'
$script:AwsReady = $false
if (-not $DryRun -and -not $SkipAws) {
    $awsVersion = (& aws --version) 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Diag "AWS CLI: $awsVersion"
        $idr = Invoke-AwsRead -What 'sts get-caller-identity' sts get-caller-identity --output json
        if ($idr.Ok -and $idr.Json) {
            $IdentityArn = $idr.Json.Arn
            $script:AwsReady = $true
            Write-Diag "Authenticated as: $IdentityArn"
            if ($idr.Json.Account -ne $AwsAccountId) {
                Write-Host "  [!!] WARNING: authenticated account $($idr.Json.Account) != expected $AwsAccountId" -ForegroundColor Yellow
            }
        } else {
            Write-Host '  [!!] Could not verify AWS identity. AWS checks will be SKIPPED (run aws configure).' -ForegroundColor Yellow
        }
    } else {
        Write-Host '  [!!] AWS CLI not found on PATH. AWS checks will be SKIPPED. Install AWS CLI v2 to evaluate infra.' -ForegroundColor Yellow
    }
} elseif ($SkipAws) {
    Write-Step '-SkipAws: AWS checks will be SKIPPED.'
}

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null

# Pre-load the source trees once (used by many Section 1/2/5 checks).
$script:BackendFiles  = @()
$script:FrontendFiles = @()
$script:RouteFiles    = @()
if (-not $DryRun) {
    Write-Step 'Reading source trees...'
    $script:BackendFiles  = Get-SourceFiles -Root $BackendSrc
    $script:FrontendFiles = if ($FrontendSrc) { Get-SourceFiles -Root $FrontendSrc } else { @() }
    $script:RouteFiles    = @($script:BackendFiles | Where-Object { $_.Rel -match '^routes[\\/]' })
    Write-Diag "backend source files : $($script:BackendFiles.Count)"
    Write-Diag "frontend source files: $($script:FrontendFiles.Count)"
}

# =============================================================================
# SECTION 1 - CODE QUALITY
# =============================================================================
Write-Phase 'SECTION 1: CODE QUALITY (frontend + backend + dependencies)'

Invoke-Check -Section '1' -Name 'Backend source tree present' -Weight 2 -Test {
    if ($script:BackendFiles.Count -gt 0) { return R-Pass "$($script:BackendFiles.Count) backend source file(s) under src/." }
    return R-Fail 'No backend source files found under src/.' 'HIGH' `
        -RootCause 'src/ missing or unreadable from this checkout.' `
        -Impact 'Cannot statically audit the backend.' `
        -Remediation 'Run from the repo root with the backend checked out.'
}

Invoke-Check -Section '1' -Name 'Parameterized SQL (no value interpolation)' -Weight 3 -Test {
    # Flag ONLY request-derived interpolation inside SQL. Interpolating vetted
    # identifiers/constants (e.g. ${cols}, ${where}, ${SOME_CONST}) is safe and
    # common; the real danger is dropping req.body/query/params/headers straight
    # into a query string instead of a $1..$n placeholder.
    $bad = @()
    $sqlReq = "(?is)(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES|SET|FROM|JOIN|LIKE|ORDER BY)\b[^;`"']{0,160}\$\{[^}]*\breq\.(body|query|params|headers)\b[^}]*\}"
    foreach ($f in $script:BackendFiles) {
        foreach ($m in [regex]::Matches($f.Text, $sqlReq)) {
            $bad += "$($f.Rel): $(($m.Value -replace '\s+', ' ').Trim())"
        }
    }
    $bad = @($bad)
    if ($bad.Count -eq 0) {
        return R-Pass 'No request-derived string interpolation found in SQL; queries use $1..$n placeholders.'
    }
    return R-Fail "Possible SQL injection: request values interpolated into SQL in $($bad.Count) place(s)." 'CRITICAL' `
        -RootCause 'req.body/query/params concatenated into a SQL string instead of a parameter placeholder.' `
        -Impact 'SQL injection -> full database compromise / PHI exfiltration.' `
        -Remediation 'Replace ${req.*} with $1..$n parameter placeholders and pass values in the params array.' `
        -Manual ("Review and parameterize: " + ($bad -join ' | ')) -Data $bad
}

Invoke-Check -Section '1' -Name 'Route authentication coverage' -Weight 3 -Test {
    # Routes that are intentionally public (signature/JWT-verified internally).
    $publicAllow = @('webhooks.js', 'auth.js', 'health.js')
    $unprotected = @()
    foreach ($f in $script:RouteFiles) {
        $base = Split-Path $f.Rel -Leaf
        if ($publicAllow -contains $base) { continue }
        $hasVerbs = [regex]::IsMatch($f.Text, "router\.(get|post|put|patch|delete)\(")
        if (-not $hasVerbs) { continue }
        $hasProtect = ($f.Text -match 'protect') -or ($f.Text -match 'requireAuth') -or ($f.Text -match 'authenticate')
        if (-not $hasProtect) { $unprotected += $base }
    }
    if ($unprotected.Count -eq 0) {
        return R-Pass 'Every non-public route module references the protect/auth middleware.'
    }
    return R-Fail "Route module(s) with verbs but no auth middleware: $($unprotected -join ', ')." 'HIGH' `
        -RootCause 'Route file defines endpoints without applying protect().' `
        -Impact 'Unauthenticated access to protected resources / PHI.' `
        -Remediation 'Add router.use(protect) (and restrict(...)) to the route module.' `
        -Manual ("Audit these route files for missing protect(): " + ($unprotected -join ', ')) -Data $unprotected
}

Invoke-Check -Section '1' -Name 'Async route error handling (try/catch or wrapper)' -Weight 1 -Test {
    $controllers = @($script:BackendFiles | Where-Object { $_.Rel -match '^controllers[\\/]' })
    if ($controllers.Count -eq 0) { return R-Info 'No controllers directory found to inspect.' }
    $noTry = @()
    foreach ($f in $controllers) {
        $asyncFns = [regex]::Matches($f.Text, "(?i)(exports\.\w+\s*=\s*async|async\s+function\s+\w+|const\s+\w+\s*=\s*async)").Count
        $tries = [regex]::Matches($f.Text, "\btry\s*\{").Count
        if ($asyncFns -gt 0 -and $tries -eq 0) { $noTry += "$($f.Rel) ($asyncFns async fn, 0 try)" }
    }
    if ($noTry.Count -eq 0) { return R-Pass 'Async controllers use try/catch for error handling.' }
    return R-Warn "Controller(s) with async handlers but no try/catch: $($noTry.Count)." 'MEDIUM' `
        -RootCause 'Unhandled promise rejection in a route handler bubbles up as an opaque 500.' `
        -Impact 'Unhandled rejections can crash the process or leak stack traces.' `
        -Remediation 'Wrap async handlers in try/catch or an asyncHandler() wrapper that forwards to next(err).' `
        -Manual ("Review: " + ($noTry -join '; ')) -Data $noTry
}

Invoke-Check -Section '1' -Name 'Backend dependency vulnerabilities (npm audit)' -Weight 2 -Test {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        return R-Info 'npm not on PATH; cannot run npm audit. Install Node.js to evaluate dependency CVEs.'
    }
    $auditJson = ''
    Push-Location $BackendDir
    try { $auditJson = (& npm audit --json 2>$null) -join "`n" } catch {} finally { Pop-Location }
    if (-not $auditJson) { return R-Info 'npm audit produced no output (offline or no lockfile).' }
    $obj = $null
    try { $obj = $auditJson | ConvertFrom-Json } catch { return R-Info 'Could not parse npm audit output.' }
    $vuln = $null
    if ($obj.PSObject.Properties.Name -contains 'metadata' -and $obj.metadata.PSObject.Properties.Name -contains 'vulnerabilities') { $vuln = $obj.metadata.vulnerabilities }
    if ($null -eq $vuln) { return R-Info 'npm audit returned no vulnerability metadata.' }
    $crit = [int]$vuln.critical; $high = [int]$vuln.high; $mod = [int]$vuln.moderate; $low = [int]$vuln.low
    $total = $crit + $high + $mod + $low
    $detail = "critical=$crit high=$high moderate=$mod low=$low"
    if ($total -eq 0) { return R-Pass "No known dependency vulnerabilities ($detail)." }
    if ($crit -gt 0 -or $high -gt 0) {
        return R-Fail "Backend has $crit critical + $high high dependency vuln(s) ($detail)." 'HIGH' `
            -RootCause 'Dependencies have published CVEs.' `
            -Impact 'Exploitable vulnerabilities in shipped code.' `
            -Remediation 'Run npm audit fix (and npm audit fix --force for breaking upgrades after testing).' `
            -FixId 'npm-audit-backend' -Auto $true -Data $detail
    }
    return R-Warn "Backend has $mod moderate + $low low dependency vuln(s) ($detail)." 'MEDIUM' `
        -RootCause 'Dependencies have lower-severity CVEs.' `
        -Impact 'Lower-risk vulnerabilities present.' `
        -Remediation 'Run npm audit fix to remediate non-breaking advisories.' `
        -FixId 'npm-audit-backend' -Auto $true -Data $detail
}

Invoke-Check -Section '1' -Name 'Frontend dependency vulnerabilities (npm audit)' -Weight 2 -Test {
    if (-not $FrontendDir) { return R-Info 'Frontend directory not found; skipping frontend npm audit.' }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { return R-Info 'npm not on PATH; cannot run frontend npm audit.' }
    $auditJson = ''
    Push-Location $FrontendDir
    try { $auditJson = (& npm audit --json 2>$null) -join "`n" } catch {} finally { Pop-Location }
    if (-not $auditJson) { return R-Info 'frontend npm audit produced no output (offline or no lockfile).' }
    $obj = $null
    try { $obj = $auditJson | ConvertFrom-Json } catch { return R-Info 'Could not parse frontend npm audit output.' }
    if (-not ($obj.PSObject.Properties.Name -contains 'metadata')) { return R-Info 'frontend npm audit returned no metadata.' }
    $vuln = $obj.metadata.vulnerabilities
    $crit = [int]$vuln.critical; $high = [int]$vuln.high; $mod = [int]$vuln.moderate; $low = [int]$vuln.low
    $total = $crit + $high + $mod + $low
    $detail = "critical=$crit high=$high moderate=$mod low=$low"
    if ($total -eq 0) { return R-Pass "No known frontend dependency vulnerabilities ($detail)." }
    if ($crit -gt 0 -or $high -gt 0) {
        return R-Fail "Frontend has $crit critical + $high high dependency vuln(s) ($detail)." 'HIGH' `
            -RootCause 'Frontend dependencies have published CVEs.' -Impact 'Exploitable client-side vulnerabilities.' `
            -Remediation 'Run npm audit fix in the frontend package.' -FixId 'npm-audit-frontend' -Auto $true -Data $detail
    }
    return R-Warn "Frontend has $mod moderate + $low low dependency vuln(s) ($detail)." 'LOW' `
        -RootCause 'Frontend dependencies have lower-severity CVEs.' -Impact 'Lower-risk client vulnerabilities.' `
        -Remediation 'Run npm audit fix in the frontend package.' -FixId 'npm-audit-frontend' -Auto $true -Data $detail
}

Invoke-Check -Section '1' -Name 'Debug logging volume (console.* in backend)' -Weight 1 -Test {
    $m = Measure-Pattern -Files $script:BackendFiles -Pattern 'console\.(log|debug)\('
    if ($m.Count -le 60) { return R-Info "console.log/debug usage: $($m.Count) call(s) across $(@($m.Files).Count) file(s) (within reasonable bounds)." }
    return R-Warn "High console.log/debug volume: $($m.Count) call(s)." 'LOW' `
        -RootCause 'Verbose stdout logging instead of a structured logger.' `
        -Impact 'Noisy logs raise the risk of accidentally logging PHI and increase log cost.' `
        -Remediation 'Route diagnostics through the structured logger (utils/logger.js) and gate debug logs on NODE_ENV.' -Data $m.Files
}

Invoke-Check -Section '1' -Name 'Local PHI artifacts in working tree (src/uploads)' -Weight 1 -Test {
    $uploadsDir = Join-Path $BackendSrc 'uploads'
    if (-not (Test-Path $uploadsDir)) { return R-Pass 'No src/uploads working directory present.' }
    $media = @(Get-ChildItem -Path $uploadsDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '(?i)\.(webm|wav|mp3|m4a|ogg|flac)$' })
    if ($media.Count -eq 0) { return R-Pass 'src/uploads exists but holds no audio artifacts.' }
    return R-Warn "$($media.Count) audio file(s) present in src/uploads (local working tree)." 'MEDIUM' `
        -RootCause 'Locally processed audio recordings persist on disk under src/uploads.' `
        -Impact 'Unencrypted PHI at rest on the developer/host machine; should live only in the encrypted S3 bucket.' `
        -Remediation 'Move processing to S3 and purge local copies; src/uploads is gitignored but still holds PHI on disk.' `
        -FixId 'purge-local-uploads' -Auto $true -Data @($media | ForEach-Object { $_.Name })
}

Invoke-Check -Section '1' -Name 'Repo hygiene (stale backup/temp directories)' -Weight 1 -Test {
    $stale = @()
    $stale += @(Get-ChildItem -Path $BackendDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(backup-v\d+|temp-extract)' } | ForEach-Object { $_.Name })
    $stale += @(Get-ChildItem -Path (Split-Path -Parent $BackendDir) -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^temp-extract' } | ForEach-Object { $_.Name })
    $stale = @($stale | Sort-Object -Unique)
    if ($stale.Count -eq 0) { return R-Pass 'No stale backup/temp directories in the backend tree.' }
    return R-Warn "$($stale.Count) stale backup/temp director(ies) present: $($stale -join ', ')." 'LOW' `
        -RootCause 'Old deploy backups / extraction folders left in the working tree.' `
        -Impact 'Clutter, larger artifacts, and a risk of shipping stale/duplicate code or old secrets.' `
        -Remediation 'Remove backup-v* and temp-extract* directories once changes are committed.' `
        -FixId 'clean-stale-dirs' -Auto $true -Data $stale
}

# =============================================================================
# SECTION 2 - SECURITY
# =============================================================================
Write-Phase 'SECTION 2: SECURITY (secrets, headers, transport, WAF, IAM, S3, RDS)'

Invoke-Check -Section '2' -Name 'No hardcoded secrets in source' -Weight 3 -Test {
    $patterns = @(
        'AKIA[0-9A-Z]{16}',                       # AWS access key id
        '(?i)aws_secret_access_key\s*[=:]\s*["''][^"'']{30,}',
        '(?i)(secret|password|passwd|api[_-]?key|token)\s*[=:]\s*["''][A-Za-z0-9+/=_\-]{24,}["'']',
        'sk-ant-[A-Za-z0-9\-]{20,}',              # Anthropic key
        '-----BEGIN (RSA|EC|OPENSSH|PRIVATE) PRIVATE KEY-----'
    )
    $hits = @()
    $allFiles = @($script:BackendFiles) + @($script:FrontendFiles)
    foreach ($f in $allFiles) {
        # Skip obvious non-secret references (env var reads, .example).
        foreach ($p in $patterns) {
            foreach ($m in [regex]::Matches($f.Text, $p)) {
                $line = $m.Value
                if ($line -match 'process\.env|import\.meta\.env|YOUR_|example|placeholder|<.*>|\$\{') { continue }
                $hits += "$($f.Rel): $($line.Substring(0,[Math]::Min(40,$line.Length)))..."
            }
        }
    }
    if ($hits.Count -eq 0) { return R-Pass 'No hardcoded credentials/keys detected in source (secrets read from env/SSM).' }
    return R-Fail "Possible hardcoded secret(s) in $($hits.Count) location(s)." 'CRITICAL' `
        -RootCause 'A credential or private key literal appears in source.' `
        -Impact 'Leaked credential -> account/data compromise.' `
        -Remediation 'Move the secret to SSM/env, rotate it immediately, and purge it from git history.' `
        -Manual ("Investigate + rotate: " + ($hits -join ' | ')) -Data $hits
}

Invoke-Check -Section '2' -Name 'Environment files are gitignored (not committed)' -Weight 3 -Test {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return R-Info 'git not on PATH; cannot verify .env tracking.' }
    Push-Location $BackendDir
    $tracked = @()
    try { $tracked = @(& git ls-files '*.env' '*/.env' '.env' '.env.*' 2>$null | Where-Object { $_ -and ($_ -notmatch '\.example$') }) } catch {} finally { Pop-Location }
    if ($tracked.Count -eq 0) { return R-Pass 'No real .env files are tracked by git (only .env.example variants).' }
    return R-Fail "$($tracked.Count) environment file(s) tracked in git: $($tracked -join ', ')." 'CRITICAL' `
        -RootCause 'A .env file with live values is committed.' `
        -Impact 'Secrets exposed in version control history.' `
        -Remediation 'git rm --cached the file, add it to .gitignore, rotate any exposed secrets.' `
        -FixId 'gitignore-env' -Auto $true -Data $tracked
}

Invoke-Check -Section '2' -Name 'CORS is allowlist-based (no wildcard origin)' -Weight 2 -Test {
    $server = @($script:BackendFiles | Where-Object { $_.Rel -match 'server\.js$' })
    if ($server.Count -eq 0) { return R-Info 'server.js not found; cannot inspect CORS config.' }
    $text = $server[0].Text
    $wildcard = ($text -match "origin\s*:\s*['""]\*['""]") -or ($text -match "Access-Control-Allow-Origin['""]?\s*,\s*['""]\*")
    $regexAny = ($text -match '\\\.vercel\\\.app\$' -and $text -notmatch "previous .*vercel.*regex.*gone")
    $hasAllowlist = ($text -match 'allowedOrigins') -or ($text -match 'origin\(origin')
    if ($wildcard) {
        return R-Fail 'CORS allows a wildcard "*" origin.' 'HIGH' `
            -RootCause 'origin set to "*".' -Impact 'Any site can call the API with credentials.' `
            -Remediation 'Replace "*" with an explicit allowlist of trusted origins.'
    }
    if ($hasAllowlist) { return R-Pass 'CORS uses an explicit origin allowlist (no wildcard).' }
    return R-Warn 'Could not confirm a CORS allowlist in server.js.' 'MEDIUM' `
        -RootCause 'No recognizable allowlist pattern found.' -Impact 'Potentially permissive CORS.' `
        -Remediation 'Confirm CORS validates origin against an explicit allowlist.'
}

Invoke-Check -Section '2' -Name 'Rate limiting on API + auth routes' -Weight 2 -Test {
    $server = @($script:BackendFiles | Where-Object { $_.Rel -match 'server\.js$' })
    if ($server.Count -eq 0) { return R-Info 'server.js not found; cannot inspect rate limiting.' }
    $text = $server[0].Text
    $hasLimiter = $text -match 'express-rate-limit|rateLimit\('
    $onApi = $text -match "use\(\s*['""]/api['""]\s*,\s*\w*[Ll]imiter"
    $onAuth = $text -match "use\(\s*['""]/api/auth['""]\s*,\s*\w*[Ll]imiter"
    if ($hasLimiter -and $onApi -and $onAuth) { return R-Pass 'Rate limiting applied to /api and a stricter limiter to /api/auth.' }
    if ($hasLimiter) { return R-Warn 'Rate limiter present but not clearly bound to both /api and /api/auth.' 'MEDIUM' `
        -RootCause 'Limiter may not cover auth brute-force surface.' -Impact 'Credential-stuffing / brute force risk.' `
        -Remediation 'Apply a stricter limiter to /api/auth in addition to the general /api limiter.' }
    return R-Fail 'No rate limiting detected in server.js.' 'HIGH' `
        -RootCause 'No express-rate-limit middleware.' -Impact 'Unthrottled brute-force / DoS.' `
        -Remediation 'Add express-rate-limit on /api and a stricter limiter on /api/auth.'
}

Invoke-Check -Section '2' -Name 'Security headers (helmet) configured' -Weight 1 -Test {
    $server = @($script:BackendFiles | Where-Object { $_.Rel -match 'server\.js$' })
    if ($server.Count -eq 0) { return R-Info 'server.js not found; cannot inspect headers.' }
    $text = $server[0].Text
    $hasHelmet = $text -match 'helmet\('
    $hasCsp = $text -match 'contentSecurityPolicy'
    $hasHsts = $text -match 'hsts'
    if ($hasHelmet -and $hasCsp -and $hasHsts) { return R-Pass 'helmet enabled with CSP + HSTS.' }
    if ($hasHelmet) { return R-Warn 'helmet present but CSP/HSTS not both confirmed.' 'LOW' `
        -RootCause 'Partial security-header config.' -Impact 'Weaker browser-side protections.' `
        -Remediation 'Enable contentSecurityPolicy and hsts in the helmet config.' }
    return R-Warn 'No helmet security headers detected.' 'MEDIUM' `
        -RootCause 'Security headers middleware missing.' -Impact 'Missing clickjacking/XSS/transport protections.' `
        -Remediation 'Add helmet() with CSP and HSTS.'
}

Invoke-Check -Section '2' -Name 'JWT secret + expiry enforced at boot' -Weight 2 -Test {
    $server = @($script:BackendFiles | Where-Object { $_.Rel -match 'server\.js$' })
    $auth = @($script:BackendFiles | Where-Object { $_.Rel -match 'controllers[\\/]authController\.js$' })
    $bootCheck = ($server.Count -gt 0) -and ($server[0].Text -match 'JWT_SECRET' -and $server[0].Text -match 'process\.exit')
    $expiry = ($auth.Count -gt 0) -and ($auth[0].Text -match 'expiresIn|JWT_EXPIRES')
    if ($bootCheck -and $expiry) { return R-Pass 'JWT_SECRET is required at boot and tokens are issued with an expiry.' }
    if ($bootCheck) { return R-Warn 'JWT_SECRET enforced at boot, but token expiry not confirmed in authController.' 'MEDIUM' `
        -RootCause 'No expiresIn found on jwt.sign.' -Impact 'Non-expiring tokens cannot be revoked by expiry.' `
        -Remediation 'Set expiresIn on jwt.sign() and verify a refresh/rotation path.' }
    return R-Warn 'Could not confirm JWT secret/expiry enforcement.' 'MEDIUM' `
        -RootCause 'No boot-time JWT_SECRET guard found.' -Impact 'Weak/missing JWT secret could be deployed.' `
        -Remediation 'Fail fast at boot if JWT_SECRET is missing/short, and set token expiry.'
}

# ---- AWS-backed security checks (read-only) ----
Invoke-Check -Section '2' -Name 'RDS encryption at rest (KMS)' -Weight 3 -RequiresAws -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS instance unavailable to this identity.' }
    if ($db.StorageEncrypted) { return R-Pass "RDS storage encrypted (KMS key: $($db.KmsKeyId))." }
    return R-Fail 'RDS storage is NOT encrypted at rest.' 'CRITICAL' `
        -RootCause 'Instance created without storage encryption.' -Impact 'PHI at rest unencrypted (HIPAA violation).' `
        -Remediation 'Restore from an encrypted snapshot; encryption cannot be toggled in place.' `
        -Manual 'Snapshot -> copy snapshot with KMS encryption -> restore -> cut over.'
}

foreach ($bkt in @($AudioBucket, $FrontendBucket)) {
    $bktName = $bkt
    Invoke-Check -Section '2' -Name "S3 default encryption: $bktName" -Weight 2 -RequiresAws -Test {
        $r = Invoke-AwsRead -What "get-bucket-encryption $bktName" s3api get-bucket-encryption --bucket $bktName --output json
        if ($r.Ok -and $r.Json) {
            $alg = @($r.Json.ServerSideEncryptionConfiguration.Rules)[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm
            return R-Pass "bucket '$bktName' default encryption: $alg."
        }
        if ($r.Stderr -match 'ServerSideEncryptionConfigurationNotFoundError') {
            return R-Fail "bucket '$bktName' has NO default encryption." 'HIGH' `
                -RootCause 'No default SSE configured.' -Impact 'New objects could land unencrypted.' `
                -Remediation 'Enable default SSE (AES256) on the bucket.' -FixId 'fix-s3-security' -Auto $true
        }
        if (Test-AccessDenied $r.Stderr) { return R-Info "bucket '$bktName' encryption: access denied to this identity." }
        return R-Warn "Could not read encryption for '$bktName': $($r.Stderr)" 'LOW' -Remediation 'Verify s3:GetEncryptionConfiguration permission.'
    }
    Invoke-Check -Section '2' -Name "S3 public access block: $bktName" -Weight 2 -RequiresAws -Test {
        $r = Invoke-AwsRead -What "get-public-access-block $bktName" s3api get-public-access-block --bucket $bktName --output json
        if ($r.Ok -and $r.Json) {
            $c = $r.Json.PublicAccessBlockConfiguration
            if ($c.BlockPublicAcls -and $c.IgnorePublicAcls -and $c.BlockPublicPolicy -and $c.RestrictPublicBuckets) {
                return R-Pass "bucket '$bktName' blocks all public access."
            }
            return R-Warn "bucket '$bktName' public-access-block is partial." 'MEDIUM' `
                -RootCause 'Not all four block settings are enabled.' -Impact 'Possible public exposure.' `
                -Remediation 'Enable all four public-access-block settings.' -FixId 'fix-s3-security' -Auto $true
        }
        if ($r.Stderr -match 'NoSuchPublicAccessBlockConfiguration') {
            return R-Fail "bucket '$bktName' has NO public-access-block." 'HIGH' `
                -RootCause 'Public access block never applied.' -Impact 'Bucket could be made public.' `
                -Remediation 'Apply a full public-access-block (all 4).' -FixId 'fix-s3-security' -Auto $true
        }
        if (Test-AccessDenied $r.Stderr) { return R-Info "bucket '$bktName' public-access-block: access denied." }
        return R-Warn "Could not read public-access-block for '$bktName': $($r.Stderr)" 'LOW' -Remediation 'Verify s3:GetBucketPublicAccessBlock permission.'
    }
}

Invoke-Check -Section '2' -Name 'WAF attached to CloudFront with rules' -Weight 3 -RequiresAws -Test {
    $w = Get-WebAclCached
    if ($null -eq $w) {
        return R-Fail "CLOUDFRONT WebACL '$WebAclName' not found." 'HIGH' `
            -RootCause 'No WAF WebACL provisioned/attached.' -Impact 'No managed protection against common web attacks.' `
            -Remediation 'Create + attach the WAF WebACL.' -Manual 'Run scripts/enable-cloudfront-waf.ps1.'
    }
    $rules = @($w.WebACL.Rules)
    if ($rules.Count -gt 0) { return R-Pass "WebACL '$WebAclName' active with $($rules.Count) rule(s)." }
    return R-Warn "WebACL '$WebAclName' exists but has no rules." 'HIGH' `
        -RootCause 'Empty WebACL.' -Impact 'WAF present but enforcing nothing.' `
        -Remediation 'Add managed + rate-limit rules.' -Manual 'Run scripts/enable-cloudfront-waf.ps1.'
}

Invoke-Check -Section '2' -Name 'WAF logging enabled' -Weight 1 -RequiresAws -Test {
    $w = Get-WebAclCached
    if ($null -eq $w) { return R-Skip 'WebACL not found; cannot check logging.' }
    $r = Invoke-AwsRead -What 'wafv2 get-logging-configuration' -UseRegion $GlobalRegion wafv2 get-logging-configuration --resource-arn $w.Summary.ARN --output json
    if ($r.Ok -and $r.Json) {
        $dests = @($r.Json.LoggingConfiguration.LogDestinationConfigs)
        return R-Pass "WAF logging enabled -> $($dests -join ', ')."
    }
    if ($r.Stderr -match 'WAFNonexistentItem|not.*found') {
        return R-Warn 'WAF logging is not configured.' 'MEDIUM' `
            -RootCause 'No logging configuration on the WebACL.' -Impact 'No record of blocked/allowed requests for forensics.' `
            -Remediation 'Enable WAF logging to a CloudWatch aws-waf-logs-* group.' -FixId 'fix-waf-logging' -Auto $true
    }
    return R-Warn "Could not read WAF logging config: $($r.Stderr)" 'LOW' -Remediation 'Verify wafv2:GetLoggingConfiguration permission.'
}

Invoke-Check -Section '2' -Name 'Root account has no access keys' -Weight 2 -RequiresAws -Test {
    $r = Invoke-AwsRead -What 'iam get-account-summary' iam get-account-summary --output json
    if ($r.Ok -and $r.Json) {
        $present = [int]$r.Json.SummaryMap.AccountAccessKeysPresent
        if ($present -eq 0) { return R-Pass 'Root account has no programmatic access keys.' }
        return R-Fail "Root account HAS $present access key(s)." 'CRITICAL' `
            -RootCause 'Root access keys exist.' -Impact 'Root key compromise = total account takeover.' `
            -Remediation 'Delete root access keys; operate via scoped IAM users/roles.' -Manual 'IAM console -> root user -> delete access keys.'
    }
    if (Test-AccessDenied $r.Stderr) { return R-Info 'iam:GetAccountSummary denied to this identity; verify root keys as admin.' }
    return R-Warn "Could not read account summary: $($r.Stderr)" 'LOW' -Remediation 'Verify iam:GetAccountSummary permission.'
}

Invoke-Check -Section '2' -Name 'TLS 1.2+ on public endpoints' -Weight 2 -RequiresNet -Test {
    $out = @()
    foreach ($h in @($FrontendHost, $CloudFrontHost)) {
        $t = Get-TlsInfo -HostName $h
        if ($t.Ok) {
            if ($t.Protocol -match 'Tls12|Tls13|1\.2|1\.3') { $r = R-Pass "$h negotiated $($t.Protocol)." }
            else { $r = R-Warn "$h negotiated $($t.Protocol) (below TLS 1.2)." 'HIGH' -Remediation 'Set CloudFront security policy TLSv1.2_2021.' }
        } else { $r = R-Warn "$h TLS handshake failed: $($t.Error)" 'LOW' -Remediation 'Verify HTTPS is served.' }
        $r.Name = "TLS: $h"
        $out += $r
    }
    return $out
}

Invoke-Check -Section '2' -Name "IAM ops user '$OpsUserName' scoped policy" -Weight 1 -RequiresAws -Test {
    $pol = Invoke-AwsRead -What 'iam list-attached-user-policies' iam list-attached-user-policies --user-name $OpsUserName --output json
    if ($pol.Ok -and $pol.Json) {
        $names = @($pol.Json.AttachedPolicies | ForEach-Object { $_.PolicyName })
        if ($names -contains $OpsPolicyName) { return R-Pass "ops user '$OpsUserName' has '$OpsPolicyName' (least-privilege scoped)." }
        return R-Warn "ops user '$OpsUserName' missing '$OpsPolicyName' (has: $($names -join ', '))." 'MEDIUM' -Remediation 'Attach the scoped managed policy.'
    }
    if (Test-AccessDenied $pol.Stderr) { return R-Info "iam:ListAttachedUserPolicies denied; verify ops policy manually." }
    if ($pol.Stderr -match 'NoSuchEntity') { return R-Warn "ops user '$OpsUserName' does not exist." 'LOW' -Remediation 'Create the scoped ops user.' }
    return R-Info "Could not enumerate ops user policies: $($pol.Stderr)"
}

# =============================================================================
# SECTION 3 - OPERATIONS
# =============================================================================
Write-Phase 'SECTION 3: OPERATIONS (logging, monitoring, backups, scaling)'

Invoke-Check -Section '3' -Name 'EB CloudWatch log groups exist' -Weight 2 -RequiresAws -Test {
    $r = Invoke-AwsRead -What 'logs describe-log-groups (eb)' logs describe-log-groups --log-group-name-prefix $EbLogGroupPrefix --output json
    if (-not $r.Ok) { return R-Warn "Could not list EB log groups: $($r.Stderr)" 'MEDIUM' -Remediation 'Verify logs:DescribeLogGroups permission.' }
    $groups = @($r.Json.logGroups)
    if ($groups.Count -gt 0) { return R-Pass "$($groups.Count) EB log group(s) under '$EbLogGroupPrefix'." $groups }
    return R-Warn "No EB log groups under '$EbLogGroupPrefix'." 'HIGH' `
        -RootCause 'EB instance log streaming not enabled.' -Impact 'No centralized app logs for audit/forensics.' `
        -Remediation 'Enable EB CloudWatch log streaming.' -Manual 'Run scripts/enable-eb-cloudwatch-logs.ps1.'
}

Invoke-Check -Section '3' -Name "Log retention >= $ExpectedRetentionDays days (EB)" -Weight 1 -RequiresAws -Test {
    $r = Invoke-AwsRead -What 'logs describe-log-groups (retention)' logs describe-log-groups --log-group-name-prefix $EbLogGroupPrefix --output json
    if (-not $r.Ok) { return R-Skip "Could not read EB log groups: $($r.Stderr)" }
    $groups = @($r.Json.logGroups)
    if ($groups.Count -eq 0) { return R-Skip 'No EB log groups to inspect.' }
    $bad = @($groups | Where-Object { (-not ($_.PSObject.Properties.Name -contains 'retentionInDays')) -or ([int]$_.retentionInDays -lt $ExpectedRetentionDays) })
    if ($bad.Count -eq 0) { return R-Pass "all $($groups.Count) EB log group(s) retain >= $ExpectedRetentionDays days." }
    return R-Warn "$($bad.Count)/$($groups.Count) EB log group(s) below $ExpectedRetentionDays-day retention." 'MEDIUM' `
        -RootCause 'Retention unset or too short.' -Impact 'HIPAA requires audit logs retained (6 years for audit; >= 90d app logs baseline).' `
        -Remediation "Set retention to >= $ExpectedRetentionDays days on EB log groups." -FixId 'set-log-retention' -Auto $true `
        -Data @($bad | ForEach-Object { $_.logGroupName })
}

Invoke-Check -Section '3' -Name 'CloudWatch CPU scaling alarms configured' -Weight 1 -RequiresAws -Test {
    $r = Invoke-AwsRead -What 'cloudwatch describe-alarms' cloudwatch describe-alarms --alarm-names $CpuHighAlarm $CpuLowAlarm --output json
    if (-not $r.Ok) { return R-Warn "Could not read alarms: $($r.Stderr)" 'MEDIUM' -Remediation 'Verify cloudwatch:DescribeAlarms permission.' }
    $found = @($r.Json.MetricAlarms | ForEach-Object { $_.AlarmName })
    $missing = @(@($CpuHighAlarm, $CpuLowAlarm) | Where-Object { $found -notcontains $_ })
    if ($missing.Count -eq 0) { return R-Pass "both scaling alarms present: $($found -join ', ')." }
    return R-Warn "missing scaling alarm(s): $($missing -join ', ')." 'MEDIUM' `
        -RootCause 'Scaling alarms not created.' -Impact 'No automatic scale-out/in under load.' `
        -Remediation 'Create CPU scaling alarms.' -Manual 'Run scripts/enable-eb-autoscaling.ps1.'
}

Invoke-Check -Section '3' -Name 'RDS enhanced monitoring enabled' -Weight 1 -RequiresAws -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS instance unavailable.' }
    $interval = 0
    if ($db.PSObject.Properties.Name -contains 'MonitoringInterval' -and $db.MonitoringInterval) { $interval = [int]$db.MonitoringInterval }
    if ($interval -gt 0) { return R-Pass "RDS enhanced monitoring enabled at ${interval}s." }
    return R-Warn 'RDS enhanced monitoring is disabled.' 'MEDIUM' `
        -RootCause 'No monitoring role/interval set.' -Impact 'Reduced OS-level visibility into DB host.' `
        -Remediation 'Enable enhanced monitoring at 60s.' -Manual 'Run scripts/enable-rds-enhanced-monitoring.ps1.'
}

Invoke-Check -Section '3' -Name 'RDS automated backups enabled' -Weight 2 -RequiresAws -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS instance unavailable.' }
    $retention = [int]$db.BackupRetentionPeriod
    if ($retention -ge 7) { return R-Pass "automated backups on: retention=${retention}d." }
    if ($retention -ge 1) { return R-Warn "backup retention is only ${retention}d." 'MEDIUM' `
        -RootCause 'Short backup window.' -Impact 'Limited point-in-time recovery range.' `
        -Remediation 'Increase backup retention to >= 7 days.' }
    return R-Fail 'Automated backups are DISABLED (retention=0).' 'HIGH' `
        -RootCause 'Backups turned off.' -Impact 'No point-in-time recovery; data loss risk.' `
        -Remediation 'Set backup retention (>= 7 days) on the production DB.' `
        -Manual 'aws rds modify-db-instance --db-instance-identifier anot-postgres --backup-retention-period 7 --apply-immediately'
}

# =============================================================================
# SECTION 4 - INFRASTRUCTURE
# =============================================================================
Write-Phase 'SECTION 4: INFRASTRUCTURE (EB, RDS, CloudFront, SG, ASG)'

Invoke-Check -Section '4' -Name 'Elastic Beanstalk environment health' -Weight 3 -RequiresAws -Test {
    $env = Get-EbEnvCached
    if ($null -eq $env) { return R-Fail "EB environment '$EbEnvName' not found." 'CRITICAL' `
        -RootCause 'Environment missing or describe denied.' -Impact 'Backend may be down.' `
        -Remediation 'Confirm EB app/env names + elasticbeanstalk:DescribeEnvironments.' }
    $detail = "status=$($env.Status) health=$($env.Health) ($($env.HealthStatus)) version=$($env.VersionLabel)"
    if ($env.Status -eq 'Ready' -and $env.Health -eq 'Green') { return R-Pass $detail $env }
    if ($env.Health -eq 'Yellow') { return R-Warn "$detail - degraded." 'HIGH' -RootCause 'Environment degraded.' -Impact 'Possible errors served.' -Remediation 'Inspect EB events + instance logs.' $env }
    return R-Fail "$detail - not Green/Ready." 'CRITICAL' -RootCause 'Environment unhealthy.' -Impact 'Backend likely erroring.' -Remediation 'Investigate EB events.' $env
}

Invoke-Check -Section '4' -Name 'RDS instance available + Multi-AZ' -Weight 2 -RequiresAws -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Fail "RDS '$RdsInstanceId' not found." 'CRITICAL' -RootCause 'DB missing or describe denied.' -Impact 'No database.' -Remediation 'Verify DB id + rds:DescribeDBInstances.' }
    $detail = "status=$($db.DBInstanceStatus) class=$($db.DBInstanceClass) multiAZ=$($db.MultiAZ) engine=$($db.Engine) $($db.EngineVersion)"
    if ($db.DBInstanceStatus -ne 'available') { return R-Fail "$detail - not available." 'CRITICAL' -RootCause 'DB not available.' -Impact 'Outage.' -Remediation 'Investigate RDS events.' $db }
    if (-not $db.MultiAZ) { return R-Warn "$detail - single-AZ." 'HIGH' `
        -RootCause 'Multi-AZ disabled.' -Impact 'No automatic failover; downtime on AZ failure.' `
        -Remediation 'Enable Multi-AZ on the production DB.' -Manual 'aws rds modify-db-instance --db-instance-identifier anot-postgres --multi-az --apply-immediately' $db }
    return R-Pass $detail $db
}

Invoke-Check -Section '4' -Name 'CloudFront distribution deployed + enabled' -Weight 2 -RequiresAws -Test {
    $d = Get-DistCached
    if ($null -eq $d) { return R-Fail "CloudFront '$DistributionId' not found." 'HIGH' -RootCause 'Distribution missing/denied.' -Impact 'CDN/edge down.' -Remediation 'Verify id + cloudfront:GetDistribution.' }
    $detail = "status=$($d.Status) enabled=$($d.DistributionConfig.Enabled) domain=$($d.DomainName)"
    if ($d.Status -eq 'Deployed' -and $d.DistributionConfig.Enabled) { return R-Pass $detail $d }
    return R-Warn "$detail - not Deployed/Enabled." 'MEDIUM' -RootCause 'Distribution not fully deployed.' -Impact 'Edge serving may be impaired.' -Remediation 'Wait for deploy or re-enable.' $d
}

Invoke-Check -Section '4' -Name 'EB origin restricted (not open 0.0.0.0/0 on 80/443)' -Weight 2 -RequiresAws -Test {
    $env = Get-EbEnvCached
    if ($null -eq $env) { return R-Skip 'EB env unavailable; cannot resolve instance SG.' }
    $res = Invoke-AwsRead -What 'describe-environment-resources (sg)' elasticbeanstalk describe-environment-resources --environment-name $EbEnvName --output json
    if (-not $res.Ok) { return R-Warn "Could not read environment resources: $($res.Stderr)" 'LOW' -Remediation 'Verify EB describe permission.' }
    if (@($res.Json.EnvironmentResources.AutoScalingGroups).Count -gt 0) { $script:AsgName = @($res.Json.EnvironmentResources.AutoScalingGroups)[0].Name }
    $insts = @($res.Json.EnvironmentResources.Instances)
    if ($insts.Count -eq 0) { return R-Skip 'No running instance to read SGs from.' }
    $ir = Invoke-AwsRead -What 'describe-instances (sg)' ec2 describe-instances --instance-ids $insts[0].Id --output json
    if (-not $ir.Ok) { return R-Warn "Could not read instance SGs: $($ir.Stderr)" 'LOW' -Remediation 'Verify ec2:DescribeInstances.' }
    $sgId = @(@($ir.Json.Reservations)[0].Instances[0].SecurityGroups)[0].GroupId
    $sgr = Invoke-AwsRead -What 'describe-security-groups' ec2 describe-security-groups --group-ids $sgId --output json
    if (-not $sgr.Ok) { return R-Warn "Could not read SG '$sgId': $($sgr.Stderr)" 'LOW' -Remediation 'Verify ec2:DescribeSecurityGroups.' }
    $perms = @(@($sgr.Json.SecurityGroups)[0].IpPermissions)
    $open = @()
    foreach ($p in $perms) {
        if ($p.IpProtocol -ne 'tcp') { continue }
        $from = if ($p.PSObject.Properties.Name -contains 'FromPort') { [int]$p.FromPort } else { -1 }
        if ($from -in 80, 443) {
            foreach ($ipr in @($p.IpRanges)) { if ($ipr.CidrIp -eq '0.0.0.0/0') { $open += $from } }
        }
    }
    $open = @($open | Sort-Object -Unique)
    if ($open.Count -gt 0) { return R-Warn "SG $sgId allows 0.0.0.0/0 on tcp/$($open -join ',')." 'HIGH' `
        -RootCause 'Origin open to the internet.' -Impact 'CloudFront/WAF can be bypassed by hitting the origin directly.' `
        -Remediation 'Restrict 80/443 to the CloudFront prefix list.' -Manual 'Run scripts/restrict-backend-to-cloudfront.ps1.' }
    return R-Pass "SG $sgId has no open 0.0.0.0/0 web ports."
}

Invoke-Check -Section '4' -Name 'Resource tagging (RDS Environment tag)' -Weight 1 -RequiresAws -Test {
    $db = Get-RdsCached
    if ($null -eq $db) { return R-Skip 'RDS unavailable.' }
    $arn = $db.DBInstanceArn
    $r = Invoke-AwsRead -What 'rds list-tags-for-resource' rds list-tags-for-resource --resource-name $arn --output json
    if (-not $r.Ok) { return R-Info "Could not read RDS tags: $($r.Stderr)" }
    $tags = @($r.Json.TagList)
    $keys = @($tags | ForEach-Object { $_.Key })
    if ($keys.Count -gt 0) { return R-Pass "RDS tagged with: $($keys -join ', ')." }
    return R-Warn 'RDS has no tags.' 'LOW' `
        -RootCause 'Untagged resource.' -Impact 'Harder cost allocation + governance.' `
        -Remediation 'Tag with Environment/Owner/CostCenter.' -Manual 'aws rds add-tags-to-resource --resource-name <arn> --tags Key=Environment,Value=production'
}

# =============================================================================
# SECTION 5 - COMPLIANCE
# =============================================================================
Write-Phase 'SECTION 5: COMPLIANCE (HIPAA artifacts, audit logging, PII handling)'

Invoke-Check -Section '5' -Name 'HIPAA / compliance documentation present' -Weight 2 -Test {
    $searchRoots = @($WorkspaceDir, (Split-Path -Parent $BackendDir), $BackendDir) | Sort-Object -Unique
    $required = @('HIPAA_COMPLIANCE_SIGN_OFF.md','SECURITY_AND_COMPLIANCE_MANUAL.md','BREACH_RESPONSE_PLAN.md','RISK_ASSESSMENT.md','PRIVACY_POLICY.md')
    $present = @(); $missing = @()
    foreach ($doc in $required) {
        $found = $false
        foreach ($root in $searchRoots) { if ($root -and (Test-Path (Join-Path $root $doc))) { $found = $true; break } }
        if ($found) { $present += $doc } else { $missing += $doc }
    }
    if ($missing.Count -eq 0) { return R-Pass "All $($required.Count) compliance documents present." $present }
    return R-Warn "Missing compliance doc(s): $($missing -join ', ')." 'MEDIUM' `
        -RootCause 'Required HIPAA artifacts absent from the repo.' -Impact 'Incomplete compliance evidence for audit.' `
        -Remediation 'Author the missing policy/plan documents.' -Manual ("Create: " + ($missing -join ', ')) -Data $missing
}

Invoke-Check -Section '5' -Name 'Audit logging implemented (HIPAA access logs)' -Weight 3 -Test {
    $logger = @($script:BackendFiles | Where-Object { $_.Rel -match 'auditLogger\.js$' })
    $usage = Measure-Pattern -Files $script:BackendFiles -Pattern '(auditLog|logAudit|writeAudit|recordAudit|audit_logs)'
    if ($logger.Count -gt 0 -and $usage.Count -gt 0) {
        return R-Pass "Audit logging utility present and referenced in $(@($usage.Files).Count) file(s)."
    }
    if ($logger.Count -gt 0) { return R-Warn 'Audit logger exists but few/no call sites detected.' 'HIGH' `
        -RootCause 'Audit logging may not cover PHI access events.' -Impact 'HIPAA requires logging access to ePHI.' `
        -Remediation 'Ensure every PHI read/write records an audit entry.' }
    return R-Fail 'No audit logging utility found.' 'HIGH' `
        -RootCause 'No centralized audit log writer.' -Impact 'HIPAA audit-control requirement unmet.' `
        -Remediation 'Implement audit logging for all PHI access and persist to an append-only store.'
}

Invoke-Check -Section '5' -Name 'Sentry/log PHI scrubbing configured' -Weight 2 -Test {
    $root = $BackendDir
    $instrument = $null
    foreach ($p in @((Join-Path $root 'instrument.js'))) { if (Test-Path $p) { $instrument = $p } }
    $scrub = $false
    if ($instrument) {
        $t = [System.IO.File]::ReadAllText($instrument)
        $scrub = ($t -match 'beforeSend') -and ($t -match '(scrub|redact|sanitize|PHI|sensitive|delete .*data|password|token)')
    }
    if ($scrub) { return R-Pass 'Sentry beforeSend scrubs sensitive data before transmission.' }
    if ($instrument) { return R-Warn 'instrument.js present but PHI scrubbing not confirmed in beforeSend.' 'MEDIUM' `
        -RootCause 'Error reports may include PHI.' -Impact 'PHI leakage to third-party error tracker.' `
        -Remediation 'Add a beforeSend hook that strips request bodies/PII before sending to Sentry.' }
    return R-Info 'No instrument.js found; confirm error-tracker PHI scrubbing elsewhere.'
}

Invoke-Check -Section '5' -Name 'Settings/PII encryption helper present' -Weight 2 -Test {
    $enc = @($script:BackendFiles | Where-Object { $_.Rel -match 'settingsEncryption\.js$|encryption' })
    if ($enc.Count -gt 0) {
        $usesCrypto = @($enc | Where-Object { $_.Text -match "require\('crypto'\)|createCipher|createCipheriv|aes-256" }).Count -gt 0
        if ($usesCrypto) { return R-Pass 'Application-layer encryption helper uses AES (settings/PII at rest).' }
        return R-Warn 'Encryption helper present but AES usage not confirmed.' 'LOW' `
            -RootCause 'Weak/unknown cipher.' -Impact 'Sensitive settings may be weakly protected.' `
            -Remediation 'Use aes-256-gcm with a KMS-derived key for sensitive settings.'
    }
    return R-Info 'No application-layer encryption helper found (relying on storage-layer encryption).'
}

# =============================================================================
# SECTION 6 - APPLICATION FUNCTIONALITY
# =============================================================================
Write-Phase 'SECTION 6: APPLICATION FUNCTIONALITY (DNS, frontend, API)'

foreach ($h in @($ApiHost, $FrontendHost)) {
    $hostName = $h
    Invoke-Check -Section '6' -Name "DNS resolution: $hostName" -Weight 2 -RequiresNet -Test {
        $addrs = @(Resolve-HostAddresses -HostName $hostName)
        if ($addrs.Count -gt 0) { return R-Pass "$hostName -> $($addrs -join ', ')." }
        return R-Fail "$hostName did not resolve." 'HIGH' -RootCause 'Missing/broken DNS record.' -Impact 'Endpoint unreachable.' -Remediation 'Create/repair the DNS record.'
    }
}

Invoke-Check -Section '6' -Name 'Frontend returns an HTML document' -Weight 3 -RequiresNet -Test {
    $p = Invoke-Probe -Url $FrontendUrl -TimeoutSec 20
    if (-not $p.Reachable) { return R-Fail "Frontend unreachable: $($p.Error)" 'HIGH' -RootCause 'CDN/origin down or DNS.' -Impact 'App not loading for users.' -Remediation 'Check CloudFront + SPA origin.' }
    if (-not $p.Ok2xx) { return R-Fail "Frontend returned HTTP $($p.Code)." 'HIGH' -RootCause 'Non-2xx from edge.' -Impact 'App not loading.' -Remediation 'Inspect CloudFront/S3 origin + cache behavior.' }
    if ($p.Body -match '<html|<!doctype|<div id="root"') { return R-Pass "Frontend OK (HTTP $($p.Code), SPA shell present)." }
    return R-Warn 'Frontend 200 but no recognizable HTML shell.' 'LOW' -Remediation 'Confirm index.html is served at root.'
}

Invoke-Check -Section '6' -Name 'Public health endpoint reachable' -Weight 2 -RequiresNet -Test {
    $candidates = @("https://$ApiHost/", "https://$ApiHost/health", "https://$ApiHost/api/health", ($CloudFrontUrl), ($CloudFrontUrl + 'health'))
    $tried = @()
    foreach ($u in $candidates) {
        $p = Invoke-Probe -Url $u -TimeoutSec 15
        $tried += "$u=$(if ($p.Reachable) { 'HTTP ' + $p.Code } else { 'unreachable' })"
        if ($p.Ok2xx) { return R-Pass "Health/root OK at $u (HTTP $($p.Code))." $tried }
    }
    return R-Warn "No public health/root endpoint returned 2xx. Tried: $($tried -join '; ')" 'MEDIUM' `
        -RootCause 'No reachable unauthenticated health route at the API host.' `
        -Impact 'Load balancers / uptime monitors have no lightweight liveness probe.' `
        -Remediation 'Expose an unauthenticated GET /health (or /api/health) returning 200 + DB status; route it via CloudFront.' `
        -Data $tried
}

# =============================================================================
# SUMMARY + SCORE
# =============================================================================
Write-Phase 'SUMMARY: findings + audit score'

$severityOrder = @{ 'CRITICAL' = 0; 'HIGH' = 1; 'MEDIUM' = 2; 'LOW' = 3; '' = 4 }
$issues = @($script:Results | Where-Object { $_.Status -eq 'FAIL' -or $_.Status -eq 'WARN' } |
    Sort-Object @{ Expression = { $severityOrder[$_.Severity] } }, Section)

$passCount = @($script:Results | Where-Object { $_.Status -eq 'PASS' }).Count
$warnCount = @($script:Results | Where-Object { $_.Status -eq 'WARN' }).Count
$failCount = @($script:Results | Where-Object { $_.Status -eq 'FAIL' }).Count
$infoCount = @($script:Results | Where-Object { $_.Status -eq 'INFO' }).Count
$skipCount = @($script:Results | Where-Object { $_.Status -eq 'SKIP' }).Count

$autoFixable = @($issues | Where-Object { $_.Auto }) 
$manualOnly  = @($issues | Where-Object { -not $_.Auto })

$scored = @($script:Results | Where-Object { $_.Status -in 'PASS', 'WARN', 'FAIL' })
$totalWeight = 0.0; $gotWeight = 0.0
foreach ($r in $scored) {
    $w = [double]$r.Weight
    $totalWeight += $w
    if ($r.Status -eq 'PASS') { $gotWeight += $w }
    elseif ($r.Status -eq 'WARN') { $gotWeight += ($w * 0.5) }
}
$score = if ($totalWeight -gt 0) { [int][math]::Round(100.0 * $gotWeight / $totalWeight) } else { 0 }

$criticals = @($script:Results | Where-Object { $_.Status -eq 'FAIL' -and $_.Severity -eq 'CRITICAL' })

if ($DryRun) {
    Write-Step 'Dry-run: no checks executed; no findings collected.'
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
            $tag = if ($i.Auto) { '[auto]' } else { '[manual]' }
            Write-Host "    - [$($i.Status)] $tag $($i.SectionName) / $($i.Name)" -ForegroundColor $col
            if ($i.Detail) { Write-Host "        $($i.Detail)" -ForegroundColor DarkGray }
        }
    }
}

Write-Host ''
Write-Host "  Checks: PASS=$passCount WARN=$warnCount FAIL=$failCount INFO=$infoCount SKIP=$skipCount" -ForegroundColor Gray
Write-Host "  Audit score: $score / 100" -ForegroundColor $(if ($score -ge 90) { 'Green' } elseif ($score -ge 70) { 'Yellow' } else { 'Red' })
Write-Host "  Findings: $($issues.Count) ($($autoFixable.Count) auto-fixable, $($manualOnly.Count) manual)  Critical: $($criticals.Count)" -ForegroundColor Gray

# =============================================================================
# OUTPUT: JSON + HTML
# =============================================================================
Write-Phase 'OUTPUT: writing JSON + HTML reports'

$jsonObj = [ordered]@{
    generatedAt = $StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    finishedAt  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    mode        = if ($DryRun) { 'dry-run' } else { 'live' }
    account     = $AwsAccountId
    region      = $Region
    identity    = $IdentityArn
    awsEvaluated = [bool]$script:AwsReady
    summary     = [ordered]@{
        score        = $score
        pass         = $passCount
        warn         = $warnCount
        fail         = $failCount
        info         = $infoCount
        skip         = $skipCount
        findingCount = $issues.Count
        autoFixable  = $autoFixable.Count
        manualOnly   = $manualOnly.Count
        critical     = $criticals.Count
    }
    findings = @($issues | ForEach-Object {
        [ordered]@{
            section     = $_.SectionName
            name        = $_.Name
            status      = $_.Status
            severity    = $_.Severity
            rootCause   = $_.RootCause
            impact      = $_.Impact
            detail      = $_.Detail
            remediation = $_.Remediation
            fixId       = $_.FixId
            auto        = $_.Auto
            manual      = $_.Manual
        }
    })
    results = @($script:Results | ForEach-Object {
        [ordered]@{
            timestamp = $_.Timestamp; section = $_.Section; sectionName = $_.SectionName
            name = $_.Name; status = $_.Status; severity = $_.Severity
            rootCause = $_.RootCause; impact = $_.Impact; detail = $_.Detail
            remediation = $_.Remediation; fixId = $_.FixId; auto = $_.Auto
            manual = $_.Manual; weight = $_.Weight
        }
    })
}
$jsonText = $jsonObj | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($JsonReport, $jsonText, [System.Text.UTF8Encoding]::new($false))
Write-Step "JSON results -> $JsonReport"

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
[void]$sb.AppendLine('<title>Anot Health - Complete Platform Audit</title>')
[void]$sb.AppendLine(@'
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#0f1419;color:#e6e6e6}
.wrap{max-width:1150px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:18px;margin:28px 0 10px;border-bottom:1px solid #2a3340;padding-bottom:6px}
.meta{color:#9aa7b4;font-size:13px;margin-bottom:18px}
.scorecard{display:flex;flex-wrap:wrap;gap:16px;margin:18px 0}
.card{background:#161d27;border:1px solid #2a3340;border-radius:10px;padding:16px 20px;min-width:140px}
.card .num{font-size:30px;font-weight:700}
.card .lbl{color:#9aa7b4;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
table{border-collapse:collapse;width:100%;margin:6px 0 12px;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #232c38;vertical-align:top}
th{color:#9aa7b4;font-weight:600;font-size:12px;text-transform:uppercase}
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap}
.badge.pass{background:#0f3d24;color:#5ee08a}
.badge.warn{background:#3d340f;color:#e0c95e}
.badge.fail{background:#3d0f0f;color:#e05e5e}
.badge.info{background:#13314d;color:#5eb6e0}
.badge.skip{background:#23262b;color:#9aa7b4}
.sev.CRITICAL,.sev.HIGH{color:#e05e5e;font-weight:700}
.sev.MEDIUM{color:#e0c95e;font-weight:700}
.sev.LOW{color:#c0a85e;font-weight:700}
.auto{background:#0f3d24;color:#5ee08a;font-size:10px;padding:1px 6px;border-radius:10px}
.manual{background:#3d340f;color:#e0c95e;font-size:10px;padding:1px 6px;border-radius:10px}
.detail{color:#c2ccd6}.rem{color:#9aa7b4;font-size:13px}.muted{color:#9aa7b4}
</style>
'@)
[void]$sb.AppendLine('</head><body><div class="wrap">')
[void]$sb.AppendLine('<h1>Anot Health - Complete Platform Audit</h1>')
$modeTxt = if ($DryRun) { 'DRY-RUN (plan only)' } else { 'LIVE' }
[void]$sb.AppendLine("<div class='meta'>Generated $(ConvertTo-HtmlText $jsonObj.generatedAt) &middot; mode <b>$modeTxt</b> &middot; account $AwsAccountId &middot; region $Region &middot; identity $(ConvertTo-HtmlText $IdentityArn) &middot; AWS evaluated: $([bool]$script:AwsReady)</div>")

[void]$sb.AppendLine('<div class="scorecard">')
[void]$sb.AppendLine("<div class='card'><div class='num'>$score</div><div class='lbl'>Audit Score / 100</div></div>")
[void]$sb.AppendLine("<div class='card'><div class='num' style='color:#5ee08a'>$passCount</div><div class='lbl'>Pass</div></div>")
[void]$sb.AppendLine("<div class='card'><div class='num' style='color:#e0c95e'>$warnCount</div><div class='lbl'>Warn</div></div>")
[void]$sb.AppendLine("<div class='card'><div class='num' style='color:#e05e5e'>$failCount</div><div class='lbl'>Fail</div></div>")
[void]$sb.AppendLine("<div class='card'><div class='num'>$($autoFixable.Count)</div><div class='lbl'>Auto-fixable</div></div>")
[void]$sb.AppendLine("<div class='card'><div class='num'>$($manualOnly.Count)</div><div class='lbl'>Manual</div></div>")
[void]$sb.AppendLine('</div>')

if ($issues.Count -gt 0) {
    [void]$sb.AppendLine('<h2>Findings (most severe first)</h2><table><tr><th>Severity</th><th>Fix</th><th>Section</th><th>Finding</th><th>Root cause / impact</th><th>Remediation</th></tr>')
    foreach ($i in $issues) {
        $sevTxt = if ($i.Severity) { $i.Severity } else { '-' }
        $fixTag = if ($i.Auto) { "<span class='auto'>AUTO</span>" } else { "<span class='manual'>MANUAL</span>" }
        $rc = (ConvertTo-HtmlText $i.RootCause); $im = (ConvertTo-HtmlText $i.Impact)
        $rcim = if ($rc -or $im) { "$rc<br><span class='muted'>$im</span>" } else { (ConvertTo-HtmlText $i.Detail) }
        $rem = (ConvertTo-HtmlText $i.Remediation)
        if ($i.Manual) { $rem += "<br><span class='muted'>manual: $(ConvertTo-HtmlText $i.Manual)</span>" }
        [void]$sb.AppendLine("<tr><td class='sev $($i.Severity)'>$sevTxt</td><td>$fixTag</td><td>$(ConvertTo-HtmlText $i.SectionName)</td><td>$(ConvertTo-HtmlText $i.Name)<br><span class='detail'>$(ConvertTo-HtmlText $i.Detail)</span></td><td>$rcim</td><td class='rem'>$rem</td></tr>")
    }
    [void]$sb.AppendLine('</table>')
}

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

[void]$sb.AppendLine("<p class='muted'>Generated by audit-complete-platform.ps1 &middot; $(ConvertTo-HtmlText ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))) &middot; Run fix-all-bugs.ps1 to remediate, then verify-production-100-percent.ps1.</p>")
[void]$sb.AppendLine('</div></body></html>')
[System.IO.File]::WriteAllText($HtmlReport, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Step "HTML report -> $HtmlReport"

Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Cyan
if ($DryRun) {
    Write-Host '  DRY-RUN COMPLETE: planned checks enumerated; reports written. Re-run with -Live.' -ForegroundColor DarkGray
} else {
    Write-Host "  AUDIT COMPLETE: score $score/100  |  $($issues.Count) finding(s)  |  $($autoFixable.Count) auto-fixable" -ForegroundColor Cyan
}
Write-Host ('=' * 78) -ForegroundColor Cyan
Write-Host "  HTML : $HtmlReport" -ForegroundColor Gray
Write-Host "  JSON : $JsonReport" -ForegroundColor Gray
Write-Host '  Next : powershell -File scripts/fix-all-bugs.ps1 -Live' -ForegroundColor Gray
Write-Host ''

# Exit non-zero on a CRITICAL finding so CI can gate.
if (-not $DryRun -and $criticals.Count -gt 0) { exit 2 }
exit 0
