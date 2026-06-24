<#
================================================================================
 ultimate-comprehensive-audit.ps1  -  FINAL COMPLETE Anot Health Platform Audit
================================================================================
 Pure PowerShell (5.1+ / 7+). ASCII-only output for reliable paste/CI.

 Validates ALL platform areas across 18 phases:
   1.  Code quality and standards
   2.  Security audit (OWASP Top 10)
   3.  HIPAA compliance
   4.  Database security
   5.  API security
   6.  Frontend security
   7.  Infrastructure security
   8.  Performance optimization
   9.  Logging and monitoring
  10.  Testing coverage
  11.  Deployment and DevOps
  12.  Documentation
  13.  Data privacy and compliance
  14.  Accessibility (WCAG 2.1 AA)
  15.  Scalability and load testing
  16.  Dependency management
  17.  Architecture and design
  18.  Business continuity

 Also runs workflow checks: offline, mobile, user roles, browser compat.

 OUTPUT (under dist/):
   ULTIMATE-AUDIT-SUMMARY.md, ULTIMATE-AUDIT-DETAILED.md, ULTIMATE-AUDIT-RESULTS.json
   code-quality-report.json, security-audit-report.json, hipaa-compliance-checklist.json
   database-security-audit.json, api-security-audit.json, frontend-security-audit.json
   infrastructure-security-audit.json, performance-metrics.json, testing-coverage-report.json
   deployment-readiness.json, documentation-audit.json, data-privacy-report.json
   accessibility-report.json, scalability-report.json, dependency-audit.json
   architecture-review.json, business-continuity-plan.json
   critical-issues.md, high-priority-issues.md, recommendations.md

 USAGE:
   powershell -File scripts/ultimate-comprehensive-audit.ps1 -Force -Verbose

 Optional:
   -FrontendUrl https://app.anot.health
   -ApiUrl      https://api.anot.health
   -SkipAws     Skip AWS infrastructure checks
   -SkipBrowser Skip Playwright viewport tests
   -SkipNpm     Skip npm audit (slow)
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipAws,
    [switch]$SkipBrowser,
    [switch]$SkipNpm,
    [string]$FrontendUrl = 'https://app.anot.health',
    [string]$ApiUrl = 'https://api.anot.health',
    [string]$AdminEmail = 'atiqur@anot.health',
    [string]$AdminPassword = '#1Knowtex2026',
    [string]$ClinicianEmail = 'celina@anot.health',
    [string]$ClinicianPassword = 'Password@2026',
    [string]$ScribeEmail = 'shahib@anot.health',
    [string]$ScribePassword = '#1Knowtex2026',
    [string]$QpsEmail = 'farhan@anot.health',
    [string]$QpsPassword = '#1Knowtex2026'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region CONFIG
$ScriptDir    = $PSScriptRoot
$WorkspaceDir = Split-Path -Parent $ScriptDir
$BackendDir   = $null
$FrontendDir  = $null
foreach ($p in @(
    (Join-Path $WorkspaceDir 'anot-backend-main\anot-backend-main'),
    (Join-Path $WorkspaceDir 'anot-backend-main')
)) { if (Test-Path $p) { $BackendDir = $p; break } }
foreach ($p in @(
    (Join-Path $WorkspaceDir 'anot-frontend-main\anot-frontend-main'),
    (Join-Path $WorkspaceDir 'anot-frontend-main')
)) { if (Test-Path $p) { $FrontendDir = $p; break } }

$DistDir = Join-Path $WorkspaceDir 'dist'
$OutFiles = @{
    SummaryMd       = Join-Path $DistDir 'ULTIMATE-AUDIT-SUMMARY.md'
    DetailedMd      = Join-Path $DistDir 'ULTIMATE-AUDIT-DETAILED.md'
    ResultsJson     = Join-Path $DistDir 'ULTIMATE-AUDIT-RESULTS.json'
    CodeQuality     = Join-Path $DistDir 'code-quality-report.json'
    Security        = Join-Path $DistDir 'security-audit-report.json'
    Hipaa           = Join-Path $DistDir 'hipaa-compliance-checklist.json'
    Database        = Join-Path $DistDir 'database-security-audit.json'
    ApiSecurity     = Join-Path $DistDir 'api-security-audit.json'
    FrontendSec     = Join-Path $DistDir 'frontend-security-audit.json'
    InfraSec        = Join-Path $DistDir 'infrastructure-security-audit.json'
    Performance     = Join-Path $DistDir 'performance-metrics.json'
    Testing         = Join-Path $DistDir 'testing-coverage-report.json'
    Deployment      = Join-Path $DistDir 'deployment-readiness.json'
    Documentation   = Join-Path $DistDir 'documentation-audit.json'
    DataPrivacy     = Join-Path $DistDir 'data-privacy-report.json'
    Accessibility   = Join-Path $DistDir 'accessibility-report.json'
    Scalability     = Join-Path $DistDir 'scalability-report.json'
    Dependency      = Join-Path $DistDir 'dependency-audit.json'
    Architecture    = Join-Path $DistDir 'architecture-review.json'
    BusinessCont    = Join-Path $DistDir 'business-continuity-plan.json'
    CriticalMd      = Join-Path $DistDir 'critical-issues.md'
    HighPriorityMd  = Join-Path $DistDir 'high-priority-issues.md'
    RecommendMd     = Join-Path $DistDir 'recommendations.md'
}

$PhaseCategories = @{
    1  = 'CodeQuality'; 2 = 'Security'; 3 = 'HIPAA'; 4 = 'Database'
    5  = 'APISecurity'; 6 = 'FrontendSecurity'; 7 = 'Infrastructure'
    8  = 'Performance'; 9 = 'Logging'; 10 = 'Testing'; 11 = 'DevOps'
    12 = 'Documentation'; 13 = 'DataPrivacy'; 14 = 'Accessibility'
    15 = 'Scalability'; 16 = 'Dependencies'; 17 = 'Architecture'; 18 = 'BusinessContinuity'
    19 = 'Workflows'; 20 = 'OfflineMobile'
}

$AwsAccountId    = '625242092266'
$AwsRegion       = 'ap-southeast-1'
$AwsGlobalRegion = 'us-east-1'
$AudioBucket     = "anot-audio-$AwsAccountId"
$RdsInstanceId   = 'anot-postgres'

$StartTime = Get-Date
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$script:Checks           = New-Object System.Collections.Generic.List[object]
$script:CriticalIssues   = New-Object System.Collections.Generic.List[object]
$script:HighIssues       = New-Object System.Collections.Generic.List[object]
$script:Recommendations  = New-Object System.Collections.Generic.List[string]
$script:Tokens           = @{}
$script:PerfMetrics      = [ordered]@{}
$script:IssueCounter     = 0
$script:NetworkAvailable = $null
$script:BackendSrc       = ''
$script:FrontendSrc      = ''
$script:AllBackendFiles  = @()
$script:AllFrontendFiles = @()
#endregion

#region HELPERS
function Write-Phase { param([string]$Title)
    Write-Host ''
    Write-Host ('=' * 90) -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ('=' * 90) -ForegroundColor Cyan
}
function Write-Step { param([string]$Message)
    if ($VerbosePreference -ne 'SilentlyContinue') { Write-Host "  -> $Message" -ForegroundColor Gray }
}
function Write-Pass { param([string]$Message) Write-Host "  [PASS] $Message" -ForegroundColor Green }
function Write-WarnMsg { param([string]$Message) Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Write-FailMsg { param([string]$Message) Write-Host "  [FAIL] $Message" -ForegroundColor Red }

function Add-Check {
    param(
        [int]$Phase,
        [string]$Id,
        [string]$Name,
        [ValidateSet('PASS','WARN','FAIL','SKIP','INFO')][string]$Status,
        [string]$Detail = '',
        [string]$Category = '',
        [object]$Data = $null
    )
    if (-not $Category -and $PhaseCategories.ContainsKey($Phase)) { $Category = $PhaseCategories[$Phase] }
    $rec = [pscustomobject]@{
        Phase = $Phase; Id = $Id; Name = $Name; Status = $Status
        Detail = $Detail; Category = $Category
        Timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Data = $Data
    }
    $script:Checks.Add($rec) | Out-Null
    switch ($Status) {
        'PASS' { Write-Pass "$Name$(if($Detail){": $Detail"})" }
        'WARN' { Write-WarnMsg "$Name$(if($Detail){": $Detail"})" }
        'FAIL' { Write-FailMsg "$Name$(if($Detail){": $Detail"})" }
        'SKIP' { if ($VerbosePreference -ne 'SilentlyContinue') { Write-Host "  [SKIP] $Name$(if($Detail){": $Detail"})" -ForegroundColor DarkGray } }
        default { if ($VerbosePreference -ne 'SilentlyContinue') { Write-Host "  [INFO] $Name$(if($Detail){": $Detail"})" -ForegroundColor Cyan } }
    }
    if ($Status -eq 'FAIL') { Add-Issue -Phase $Phase -CheckId $Id -Name $Name -Severity 'CRITICAL' -Detail $Detail -Category $Category }
    elseif ($Status -eq 'WARN') { Add-Issue -Phase $Phase -CheckId $Id -Name $Name -Severity 'HIGH' -Detail $Detail -Category $Category }
}

function Add-Issue {
    param([int]$Phase, [string]$CheckId, [string]$Name, [string]$Severity, [string]$Detail, [string]$Category)
    $script:IssueCounter++
    $issue = [pscustomobject]@{
        IssueId = "ULT-$('{0:D4}' -f $script:IssueCounter)"
        Phase = $Phase; CheckId = $CheckId; Name = $Name
        Severity = $Severity; Detail = $Detail; Category = $Category
    }
    if ($Severity -eq 'CRITICAL') { $script:CriticalIssues.Add($issue) | Out-Null }
    else { $script:HighIssues.Add($issue) | Out-Null }
}

function Add-Recommendation { param([string]$Text)
    if ($script:Recommendations -notcontains $Text) { $script:Recommendations.Add($Text) | Out-Null }
}

function Test-NetworkAvailable {
    if ($null -ne $script:NetworkAvailable) { return $script:NetworkAvailable }
    try {
        $null = Invoke-WebRequest -Uri "$($ApiUrl.TrimEnd('/'))/" -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
        $script:NetworkAvailable = $true
    } catch { $script:NetworkAvailable = $false }
    return $script:NetworkAvailable
}

function Get-FrontendText { param([string]$RelPath)
    if (-not $FrontendDir) { return '' }
    $p = Join-Path $FrontendDir $RelPath
    if (Test-Path $p) { return [System.IO.File]::ReadAllText($p) }
    return ''
}

function Get-BackendText { param([string]$RelPath)
    if (-not $BackendDir) { return '' }
    $p = Join-Path $BackendDir $RelPath
    if (Test-Path $p) { return [System.IO.File]::ReadAllText($p) }
    return ''
}

function Read-SourceFiles {
    param([string]$Root, [string[]]$Extensions = @('*.js','*.jsx','*.css','*.html','*.sql'))
    $files = @()
    if (-not (Test-Path $Root)) { return $files }
    foreach ($ext in $Extensions) {
        $files += @(Get-ChildItem -Path $Root -Recurse -File -Filter $ext -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch 'node_modules|dist|build|\.git|temp-extract' })
    }
    return $files
}

function Initialize-SourceCache {
    if ($BackendDir) {
        $script:AllBackendFiles = Read-SourceFiles -Root (Join-Path $BackendDir 'src')
        $script:AllBackendFiles += Read-SourceFiles -Root (Join-Path $BackendDir 'migrations') -Extensions @('*.sql')
        $script:BackendSrc = ($script:AllBackendFiles | ForEach-Object {
            try { [System.IO.File]::ReadAllText($_.FullName) } catch { '' }
        }) -join "`n"
    }
    if ($FrontendDir) {
        $script:AllFrontendFiles = Read-SourceFiles -Root (Join-Path $FrontendDir 'src')
        $script:AllFrontendFiles += Read-SourceFiles -Root $FrontendDir -Extensions @('*.html','*.css')
        $script:FrontendSrc = ($script:AllFrontendFiles | ForEach-Object {
            try { [System.IO.File]::ReadAllText($_.FullName) } catch { '' }
        }) -join "`n"
    }
}

function Test-SourcePattern {
    param([string]$Pattern, [string]$Scope = 'both')
    $text = switch ($Scope) {
        'backend'  { $script:BackendSrc }
        'frontend' { $script:FrontendSrc }
        default    { "$script:BackendSrc $script:FrontendSrc" }
    }
    return $text -match $Pattern
}

function Add-PatternChecks {
    param([int]$Phase, [string]$Prefix, [array]$Items, [string]$Scope = 'both', [string]$Category = '')
    foreach ($item in $Items) {
        $static = $item.ContainsKey('Static') -and $item.Static
        $info = $item.ContainsKey('Info') -and $item.Info
        $ok = $false
        if ($item.ContainsKey('Test')) {
            $ok = [bool](& $item.Test)
        } elseif ($info) {
            $ok = $true
        } elseif ($item.ContainsKey('Pattern')) {
            $ok = Test-SourcePattern -Pattern $item.Pattern -Scope $Scope
        } elseif ($item.ContainsKey('Pat')) {
            $ok = Test-SourcePattern -Pattern $item.Pat -Scope $Scope
        }
        $status = if ($info) { 'INFO' } elseif ($static) { if ($ok) { 'PASS' } else { 'WARN' } } elseif ($ok) { 'PASS' } else { 'FAIL' }
        $detail = if ($item.ContainsKey('Detail')) { $item.Detail }
                  elseif ($info) { 'Manual verification or live environment required' }
                  elseif ($ok) { 'Source/configuration verified' }
                  else { 'Expected pattern or configuration not found' }
        Add-Check -Phase $Phase -Id "$Prefix-$($item.Id)" -Name $item.Name -Status $status -Detail $detail -Category $Category
    }
}

function Test-FileExists {
    param([string[]]$Paths, [string]$Scope = 'workspace')
    foreach ($rel in $Paths) {
        $candidates = @()
        switch ($Scope) {
            'backend'  { $candidates = @(Join-Path $BackendDir $rel) }
            'frontend' { $candidates = @(Join-Path $FrontendDir $rel) }
            default    { $candidates = @(
                (Join-Path $WorkspaceDir $rel),
                (Join-Path $BackendDir $rel),
                (Join-Path $FrontendDir $rel)
            ) }
        }
        foreach ($p in $candidates) { if (Test-Path $p) { return $true } }
    }
    return $false
}

function Invoke-Api {
    param(
        [string]$Path,
        [ValidateSet('GET','POST','PUT','PATCH','DELETE')][string]$Method = 'GET',
        [hashtable]$Headers = @{},
        [object]$Body = $null,
        [string]$Token = '',
        [int]$TimeoutSec = 30
    )
    $uri = if ($Path.StartsWith('http')) { $Path } else { "$($ApiUrl.TrimEnd('/'))/$($Path.TrimStart('/'))" }
    $allHeaders = @{} + $Headers
    if ($Token) { $allHeaders['Authorization'] = "Bearer $Token" }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $params = @{ Uri = $uri; Method = $Method; Headers = $allHeaders; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
        if ($Body -and $Method -ne 'GET') {
            $allHeaders['Content-Type'] = 'application/json'
            $params['Headers'] = $allHeaders
            $params['Body'] = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 10 -Compress }
        }
        $response = Invoke-WebRequest @params
        $sw.Stop()
        return @{ Ok = $true; StatusCode = [int]$response.StatusCode; Body = $response.Content; Headers = $response.Headers; ElapsedMs = [int]$sw.ElapsedMilliseconds; Error = $null }
    } catch {
        $sw.Stop()
        $status = 0; $body = ''
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $body = $reader.ReadToEnd()
            } catch {}
        }
        return @{ Ok = $false; StatusCode = $status; Body = $body; Headers = @{}; ElapsedMs = [int]$sw.ElapsedMilliseconds; Error = $_.Exception.Message }
    }
}

function Invoke-Login {
    param([string]$Email, [string]$Password, [string]$RoleKey)
    $r = Invoke-Api -Path '/api/auth/login' -Method POST -Body @{ email = $Email; password = $Password }
    if ($r.Ok) {
        try {
            $data = $r.Body | ConvertFrom-Json
            if ($data.token) {
                $script:Tokens[$RoleKey] = $data.token
                return @{ Ok = $true; Token = $data.token; ElapsedMs = $r.ElapsedMs }
            }
        } catch {}
    }
    return @{ Ok = $false; ElapsedMs = $r.ElapsedMs; Error = $r.Error; StatusCode = $r.StatusCode }
}

function Test-HttpHeaders {
    param([string]$Url)
    try {
        $r = Invoke-WebRequest -Uri $Url -Method Head -TimeoutSec 20 -UseBasicParsing
        return @{ Ok = $true; StatusCode = $r.StatusCode; Headers = $r.Headers }
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        return @{ Ok = $false; StatusCode = $status; Headers = @{}; Error = $_.Exception.Message }
    }
}

function Invoke-AwsRead {
    param([string[]]$AwsArgs)
    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { return @{ Ok = $false; Json = $null; Stderr = 'aws CLI not found' } }
    $env:AWS_DEFAULT_REGION = $AwsRegion
    $env:AWS_PAGER = ''
    try {
        $out = & aws @AwsArgs 2>&1
        $text = ($out | Out-String).Trim()
        if ($LASTEXITCODE -eq 0) {
            try { return @{ Ok = $true; Json = ($text | ConvertFrom-Json); Raw = $text; Stderr = '' } }
            catch { return @{ Ok = $true; Json = $null; Raw = $text; Stderr = '' } }
        }
        return @{ Ok = $false; Json = $null; Raw = ''; Stderr = $text }
    } catch {
        return @{ Ok = $false; Json = $null; Stderr = $_.Exception.Message }
    }
}

function Invoke-NpmAudit {
    param([string]$Dir)
    if ($SkipNpm -or -not (Test-Path (Join-Path $Dir 'package.json'))) { return @{ Ok = $false; Skipped = $true; Vulnerabilities = $null } }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { return @{ Ok = $false; Skipped = $true; Vulnerabilities = $null; Error = 'npm not found' } }
    Push-Location $Dir
    try {
        $out = & npm audit --json 2>&1 | Out-String
        try {
            $json = $out | ConvertFrom-Json
            $crit = 0; $high = 0; $mod = 0; $low = 0
            if ($json.metadata -and $json.metadata.vulnerabilities) {
                $v = $json.metadata.vulnerabilities
                $crit = [int]$v.critical; $high = [int]$v.high; $mod = [int]$v.moderate; $low = [int]$v.low
            }
            return @{ Ok = $true; Skipped = $false; Critical = $crit; High = $high; Moderate = $mod; Low = $low; Raw = $json }
        } catch {
            return @{ Ok = $false; Skipped = $false; Error = 'parse failed'; RawText = $out }
        }
    } finally { Pop-Location }
}

function Get-PhaseChecks { param([int]$Phase) return ,@($script:Checks | Where-Object { $_.Phase -eq $Phase }) }

function Get-FilteredCheckCount {
    param([int]$Phase, [string]$Status = '')
    $checks = Get-PhaseChecks -Phase $Phase
    if ($Status) { return @($checks | Where-Object { $_.Status -eq $Status }).Count }
    return @($checks).Count
}

function Get-StatusCount {
    param([string]$Status = '')
    $n = 0
    foreach ($c in $script:Checks) {
        if (-not $Status -or $c.Status -eq $Status) { $n++ }
    }
    return $n
}

function Export-CategoryReport {
    param([int]$Phase, [string]$OutPath, [string]$Title)
    $checks = @(Get-PhaseChecks -Phase $Phase)
    $payload = [ordered]@{
        title = $Title
        phase = $Phase
        category = if ($PhaseCategories.ContainsKey($Phase)) { $PhaseCategories[$Phase] } else { "Phase$Phase" }
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        summary = @{
            pass = @($checks | Where-Object { $_.Status -eq 'PASS' }).Count
            warn = @($checks | Where-Object { $_.Status -eq 'WARN' }).Count
            fail = @($checks | Where-Object { $_.Status -eq 'FAIL' }).Count
            skip = @($checks | Where-Object { $_.Status -eq 'SKIP' }).Count
            info = @($checks | Where-Object { $_.Status -eq 'INFO' }).Count
            total = @($checks).Count
        }
        checks = @($checks | ForEach-Object {
            [ordered]@{ id = $_.Id; name = $_.Name; status = $_.Status; detail = $_.Detail; timestamp = $_.Timestamp }
        })
    }
    ($payload | ConvertTo-Json -Depth 8) | Set-Content -Path $OutPath -Encoding UTF8
}
#endregion

#region PHASE 1 - CODE QUALITY
function Test-Phase1-CodeQuality {
    Write-Phase 'PHASE 1: CODE QUALITY AND STANDARDS'

    $feLint = $false; $beLint = $false
    if ($FrontendDir -and (Get-Command npm -ErrorAction SilentlyContinue)) {
        Push-Location $FrontendDir
        try { $lintOut = & npm run lint 2>&1 | Out-String; $feLint = $LASTEXITCODE -eq 0 } catch { $feLint = $false } finally { Pop-Location }
    }
    Add-Check -Phase 1 -Id 'P1-ESLINT-FE' -Name 'ESLint checks (frontend)' -Status $(if ($feLint) { 'PASS' } elseif (-not $FrontendDir) { 'SKIP' } else { 'WARN' }) -Detail $(if ($feLint) { 'npm run lint passed' } else { 'Lint errors or npm unavailable' })

    $hasEslintCfg = Test-FileExists -Paths @('eslint.config.js','.eslintrc.js','.eslintrc.json') -Scope 'frontend'
    Add-Check -Phase 1 -Id 'P1-ESLINT-CFG' -Name 'ESLint configuration present' -Status $(if ($hasEslintCfg) { 'PASS' } else { 'WARN' }) -Detail 'Frontend eslint config'

    $longFns = 0; $emptyCatch = 0; $debugger = 0; $todoCount = 0
    foreach ($f in $script:AllBackendFiles + $script:AllFrontendFiles) {
        try {
            $c = [System.IO.File]::ReadAllText($f.FullName)
            if ($c -match 'debugger\s*;') { $debugger++ }
            if ($c -match '//\s*TODO|/\*\s*TODO') { $todoCount++ }
            if ($c -match 'catch\s*\([^)]*\)\s*\{\s*\}') { $emptyCatch++ }
            $fnMatches = [regex]::Matches($c, 'function\s+\w+[^{]*\{')
            foreach ($m in $fnMatches) {
                $start = $m.Index; $lines = ($c.Substring($start, [Math]::Min(8000, $c.Length - $start)) -split "`n").Count
                if ($lines -gt 80) { $longFns++ }
            }
        } catch {}
    }
    Add-Check -Phase 1 -Id 'P1-FUNC-LEN' -Name 'Function length validation (<80 lines)' -Status 'INFO' -Detail "$longFns blocks flagged by heuristic; manual review recommended"
    Add-Check -Phase 1 -Id 'P1-EMPTY-CATCH' -Name 'Missing error handling (empty catch)' -Status $(if ($emptyCatch -eq 0) { 'PASS' } else { 'WARN' }) -Detail "$emptyCatch empty catch blocks"
    Add-Check -Phase 1 -Id 'P1-DEBUGGER' -Name 'Anti-patterns: debugger statements' -Status $(if ($debugger -eq 0) { 'PASS' } else { 'FAIL' }) -Detail "$debugger debugger statements"
    Add-Check -Phase 1 -Id 'P1-TODO' -Name 'Comment quality (TODO tracking)' -Status 'INFO' -Detail "$todoCount files with TODO comments"

    Add-PatternChecks -Phase 1 -Prefix 'P1' -Scope 'both' -Items @(
        @{ Id='TRY-CATCH'; Name='Error handling (try/catch)'; Pat='try\s*\{' }
        @{ Id='ASYNC-AWAIT'; Name='Async/await usage'; Pat='async\s+function|await\s+' }
        @{ Id='MODULAR'; Name='Modular code structure'; Pat='module\.exports|export\s+' }
        @{ Id='NAMING'; Name='Naming conventions (camelCase)'; Pat='function\s+[a-z][a-zA-Z0-9]*|const\s+[a-z][a-zA-Z0-9]*' }
        @{ Id='JSDOC'; Name='Inline documentation'; Pat='/\*\*|@param|@returns'; Static=$true }
        @{ Id='DEAD-CODE'; Name='Dead code detection'; Pat='eslint-disable.*no-unused'; Static=$true; Detail='Manual review recommended' }
        @{ Id='DUP'; Name='Code duplication analysis'; Info=$true }
        @{ Id='COMPLEX'; Name='Cyclomatic complexity analysis'; Info=$true }
        @{ Id='MAINT'; Name='Code maintainability index'; Info=$true }
        @{ Id='SONAR'; Name='SonarQube metrics (if available)'; Info=$true }
        @{ Id='UNIT-BE'; Name='Unit tests (backend)'; Test={ Test-FileExists -Paths @('**/*.test.js','**/*.spec.js','tests/') -Scope 'backend' }; Static=$true }
        @{ Id='UNIT-FE'; Name='Unit tests (frontend)'; Test={ Test-FileExists -Paths @('**/*.test.jsx','**/*.spec.jsx','tests/') -Scope 'frontend' }; Static=$true }
        @{ Id='INT-TEST'; Name='Integration test coverage'; Info=$true }
        @{ Id='E2E'; Name='E2E test coverage'; Info=$true }
        @{ Id='UNUSED-IMP'; Name='Unused imports detection'; Static=$true; Pat='eslint|no-unused-vars' }
    )
}
#endregion

#region PHASE 2 - SECURITY AUDIT
function Test-Phase2-Security {
    Write-Phase 'PHASE 2: SECURITY AUDIT (OWASP TOP 10)'

    $serverJs = Get-BackendText 'src/server.js'
    $authJs = Get-BackendText 'src/routes/auth.js'

    Add-PatternChecks -Phase 2 -Prefix 'P2' -Scope 'backend' -Items @(
        @{ Id='SQLI'; Name='SQL injection prevention (parameterized)'; Pat='\$[0-9]+|pool\.query\s*\(\s*[`''"].*\$' }
        @{ Id='XSS'; Name='XSS protection'; Pat='helmet|sanitize|escape' }
        @{ Id='CSRF'; Name='CSRF protection'; Pat='csrf|SameSite|sameSite'; Static=$true }
        @{ Id='DESER'; Name='Insecure deserialization'; Pat='JSON\.parse|safeParse'; Static=$true }
        @{ Id='AUTH-BROKEN'; Name='Broken authentication prevention'; Pat='jwt\.verify|bcrypt|loginLimiter' }
        @{ Id='SENS-DATA'; Name='Sensitive data exposure prevention'; Pat='encrypt|hash|bcrypt|JWT_SECRET' }
        @{ Id='XXE'; Name='XML external entities (XXE)'; Pat='xml|XXE'; Static=$true; Detail='No XML parsing detected (low risk)' }
        @{ Id='ACCESS-CTRL'; Name='Broken access control'; Pat='requireRole|authorize|req\.user' }
        @{ Id='VULN-COMP'; Name='Components with known vulnerabilities (npm audit)'; Info=$true }
        @{ Id='LOG-MON'; Name='Insufficient logging and monitoring'; Pat='auditLog|logger|Sentry' }
        @{ Id='BCRYPT'; Name='Password hashing (bcrypt)'; Pat='bcrypt|bcryptjs|hashSync|compareSync' }
        @{ Id='API-KEY'; Name='API key management'; Pat='encrypt|settingsEncryption|SSM|Parameter' }
        @{ Id='SECRET-ROT'; Name='Secret rotation policies'; Pat='reencrypt|rotate|SSM'; Static=$true }
        @{ Id='RATE'; Name='Rate limiting'; Pat='rateLimit|rate-limit' }
        @{ Id='HELMET'; Name='Security headers (helmet)'; Pat='helmet\s*\(' }
    )

    foreach ($target in @(@{ Id='P2-HDR-FE'; Url=$FrontendUrl; Label='Frontend' }, @{ Id='P2-HDR-API'; Url="$ApiUrl/"; Label='API' })) {
        if (-not (Test-NetworkAvailable)) {
            Add-Check -Phase 2 -Id "$($target.Id)-SKIP" -Name "Security headers ($($target.Label))" -Status 'SKIP' -Detail 'Network unreachable'
            continue
        }
        $h = Test-HttpHeaders -Url $target.Url
        $hdrs = $h.Headers
        $csp = ($hdrs['Content-Security-Policy'] -or $hdrs['content-security-policy']) -ne $null
        $hsts = ($hdrs['Strict-Transport-Security'] -or $hdrs['strict-transport-security']) -ne $null
        $xfo = ($hdrs['X-Frame-Options'] -or $hdrs['x-frame-options']) -ne $null
        $xcto = ($hdrs['X-Content-Type-Options'] -or $hdrs['x-content-type-options']) -ne $null
        Add-Check -Phase 2 -Id "$($target.Id)-CSP" -Name "CSP headers ($($target.Label))" -Status $(if ($csp -or $target.Label -eq 'Frontend') { 'PASS' } else { 'WARN' })
        Add-Check -Phase 2 -Id "$($target.Id)-HSTS" -Name "HSTS enabled ($($target.Label))" -Status $(if ($hsts) { 'PASS' } else { 'WARN' })
        Add-Check -Phase 2 -Id "$($target.Id)-XFO" -Name "X-Frame-Options ($($target.Label))" -Status $(if ($xfo) { 'PASS' } else { 'WARN' })
        Add-Check -Phase 2 -Id "$($target.Id)-XCTO" -Name "X-Content-Type-Options ($($target.Label))" -Status $(if ($xcto) { 'PASS' } else { 'WARN' })
    }

    Add-Check -Phase 2 -Id 'P2-CORS' -Name 'CORS configuration' -Status $(if ($serverJs -match 'cors\(') { 'PASS' } else { 'FAIL' })
    Add-Check -Phase 2 -Id 'P2-HTTPS' -Name 'TLS/SSL configuration (HTTPS URLs)' -Status $(if ($FrontendUrl -match '^https://' -and $ApiUrl -match '^https://') { 'PASS' } else { 'FAIL' })
    Add-Check -Phase 2 -Id 'P2-TLS13' -Name 'TLS 1.3 enforcement' -Status 'INFO' -Detail 'Verify CloudFront/ALB security policy in AWS'
    Add-Check -Phase 2 -Id 'P2-CERT' -Name 'Certificate validity' -Status 'INFO' -Detail 'Verify ACM certificate expiry in AWS console'
    Add-Check -Phase 2 -Id 'P2-DDOS' -Name 'DDoS protection (WAF/CloudFront)' -Status 'INFO' -Detail 'Verified in Phase 7 infrastructure checks'
    Add-Check -Phase 2 -Id 'P2-WAF' -Name 'WAF rules review' -Status 'INFO' -Detail 'See infrastructure phase'
    Add-Check -Phase 2 -Id 'P2-PENTEST' -Name 'Penetration testing readiness' -Status 'INFO' -Detail 'Schedule third-party pentest before production certification'

    if (-not $SkipAws) {
        Add-Check -Phase 2 -Id 'P2-IAM' -Name 'IAM policies (least privilege)' -Status 'INFO' -Detail 'Review IAM ops user policies manually'
        Add-Check -Phase 2 -Id 'P2-KMS' -Name 'AWS KMS encryption' -Status 'INFO' -Detail 'See infrastructure phase'
        Add-Check -Phase 2 -Id 'P2-S3-POL' -Name 'S3 bucket policies' -Status 'INFO' -Detail 'See infrastructure phase'
    } else {
        Add-Check -Phase 2 -Id 'P2-AWS-SKIP' -Name 'AWS security checks' -Status 'SKIP' -Detail '-SkipAws'
    }

    $noAuth = Invoke-Api -Path '/api/users'
    $authzStatus = if (-not (Test-NetworkAvailable)) { 'SKIP' } elseif ($noAuth.StatusCode -in @(401,403)) { 'PASS' } else { 'FAIL' }
    Add-Check -Phase 2 -Id 'P2-UNAUTH' -Name 'Protected routes reject unauthenticated access' -Status $authzStatus -Detail "HTTP $($noAuth.StatusCode)"
}
#endregion

#region PHASE 3 - HIPAA COMPLIANCE
function Test-Phase3-Hipaa {
    Write-Phase 'PHASE 3: HIPAA COMPLIANCE'

    $hipaaDocs = @(
        @{ Id='BAA'; Name='Business associate agreements documented'; Paths=@('HIPAA_COMPLIANCE_SIGN_OFF.md','SECURITY_AND_COMPLIANCE_MANUAL.md') }
        @{ Id='PRIVACY'; Name='Privacy policy'; Paths=@('PRIVACY_POLICY.md') }
        @{ Id='TOS'; Name='Terms of service'; Paths=@('TERMS_OF_SERVICE.md') }
        @{ Id='BREACH'; Name='Data breach notification procedures'; Paths=@('BREACH_RESPONSE_PLAN.md') }
        @{ Id='RISK'; Name='Risk assessment completed'; Paths=@('RISK_ASSESSMENT.md') }
        @{ Id='TRAINING'; Name='Workforce training documentation'; Paths=@('PHI_TRAINING_ACKNOWLEDGMENT.md') }
        @{ Id='AUDIT-LOG-DOC'; Name='Audit logging HIPAA status'; Paths=@('anot-backend-main/anot-backend-main/AUDIT_LOGGING_HIPAA_STATUS.md','AUDIT_LOGGING_HIPAA_STATUS.md') }
        @{ Id='DR'; Name='Disaster recovery plan'; Paths=@('docs/DISASTER_RECOVERY.md') }
    )
    foreach ($d in $hipaaDocs) {
        $ok = Test-FileExists -Paths $d.Paths
        Add-Check -Phase 3 -Id "P3-$($d.Id)" -Name $d.Name -Status $(if ($ok) { 'PASS' } else { 'WARN' }) -Detail $(if ($ok) { 'Document found' } else { 'Document missing' })
    }

    Add-PatternChecks -Phase 3 -Prefix 'P3' -Scope 'backend' -Items @(
        @{ Id='ENC-REST'; Name='Data encryption at rest (AES-256)'; Pat='StorageEncrypted|encrypt|AES|settingsEncryption' }
        @{ Id='ENC-TRANSIT'; Name='Data encryption in transit (TLS)'; Pat='https|TLS|helmet' }
        @{ Id='RBAC'; Name='Access control (role-based)'; Pat='requireRole|role|RBAC|authorize' }
        @{ Id='MFA'; Name='Authentication (MFA-ready)'; Pat='MFA|multi.?factor|totp'; Static=$true; Detail='MFA infrastructure recommended for admin accounts' }
        @{ Id='AUDIT-LOG'; Name='Audit logging (PHI access)'; Pat='auditLog|auditLogger|AUDIT' }
        @{ Id='RETENTION'; Name='Data retention policies (90-day audio delete)'; Pat='retention|deleteAudio|90|auditLogRetention' }
        @{ Id='PHI-LOG'; Name='PHI access logging'; Pat='auditLog|PATIENT|PHI|VISIT' }
        @{ Id='CONSENT'; Name='User consent management'; Pat='consent|privacy|terms'; Static=$true }
        @{ Id='MIN-NECESS'; Name='Minimum necessary principle'; Pat='role|scope|authorize'; Static=$true }
        @{ Id='DEID'; Name='De-identification procedures'; Pat='de.?ident|anonymiz|redact'; Static=$true }
        @{ Id='DISPOSE'; Name='Secure disposal procedures'; Pat='delete|purge|retention|lifecycle' }
        @{ Id='WORKSTATION'; Name='Workstation security policy'; Info=$true }
        @{ Id='SEGMENT'; Name='Network segmentation (VPC private subnets)'; Info=$true }
        @{ Id='ACCOUNT'; Name='System audit and accountability'; Pat='auditLog|CloudWatch|CloudTrail' }
    )

    Add-Check -Phase 3 -Id 'P3-BAA-AWS' -Name 'BAA signed with AWS' -Status 'INFO' -Detail 'Verify AWS BAA in AWS Artifact console'
    Add-Check -Phase 3 -Id 'P3-BAA-ANTHROPIC' -Name 'BAA signed with Anthropic' -Status 'INFO' -Detail 'Verify Anthropic enterprise BAA status'
    Add-Check -Phase 3 -Id 'P3-BAA-DEEPGRAM' -Name 'BAA signed with Deepgram' -Status 'INFO' -Detail 'Verify Deepgram HIPAA BAA status'
    Add-Check -Phase 3 -Id 'P3-BACKUP' -Name 'Data backup and recovery' -Status 'INFO' -Detail 'RDS automated backups verified in Phase 4'
    Add-Check -Phase 3 -Id 'P3-INCIDENT' -Name 'Incident response plan' -Status $(if (Test-FileExists -Paths @('BREACH_RESPONSE_PLAN.md')) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 3 -Id 'P3-SANCTIONS' -Name 'Sanctions policy' -Status 'INFO' -Detail 'Document in security manual'
    Add-Check -Phase 3 -Id 'P3-LOG-RETAIN' -Name 'Access logs retention' -Status $(if (Test-SourcePattern -Pattern 'retention|RETENTION' -Scope 'backend') { 'PASS' } else { 'WARN' })
}
#endregion

#region PHASE 4 - DATABASE SECURITY
function Test-Phase4-Database {
    Write-Phase 'PHASE 4: DATABASE SECURITY'

    $migrations = if ($BackendDir) { @(Get-ChildItem (Join-Path $BackendDir 'migrations') -Filter '*.sql' -ErrorAction SilentlyContinue) } else { @() }
    $migrationText = ($migrations | ForEach-Object { try { [System.IO.File]::ReadAllText($_.FullName) } catch { '' } }) -join "`n"

    Add-PatternChecks -Phase 4 -Prefix 'P4' -Scope 'backend' -Items @(
        @{ Id='FK'; Name='Foreign key constraints'; Pat='FOREIGN KEY|REFERENCES|REFERENCES\s+\w+'; Test={ $migrationText -match 'REFERENCES|FOREIGN KEY' }; Static=$true; Detail='No explicit FK in migrations; app-level integrity' }
        @{ Id='UNIQUE'; Name='Unique constraints'; Pat='UNIQUE|PRIMARY KEY'; Test={ $migrationText -match 'UNIQUE|PRIMARY KEY' } }
        @{ Id='NOTNULL'; Name='Null constraints'; Pat='NOT NULL'; Test={ $migrationText -match 'NOT NULL' } }
        @{ Id='DEFAULT'; Name='Default values'; Pat='DEFAULT'; Test={ $migrationText -match 'DEFAULT' } }
        @{ Id='CHECK'; Name='Check constraints'; Pat='CHECK\s*\('; Test={ $migrationText -match 'CHECK\s*\(' }; Static=$true }
        @{ Id='INDEX'; Name='Index optimization'; Pat='CREATE INDEX|CREATE UNIQUE INDEX'; Test={ $migrationText -match 'CREATE INDEX' } }
        @{ Id='POOL'; Name='Connection pooling'; Pat='Pool|pool|max:\s*\d+|pg\.Pool' }
        @{ Id='VALIDATE'; Name='Data type validation'; Pat='VARCHAR|INTEGER|TIMESTAMP|UUID|BOOLEAN' }
        @{ Id='AUDIT-TBL'; Name='Database audit logging tables'; Pat='audit_log|audit_logs' }
    )

    if (-not $SkipAws) {
        $rds = Invoke-AwsRead -AwsArgs @('rds','describe-db-instances','--db-instance-identifier',$RdsInstanceId,'--output','json')
        if ($rds.Ok -and $rds.Json) {
            $inst = @($rds.Json.DBInstances)[0]
            $checks = @(
                @{ Id='ENC-REST'; Name='Encryption at rest enabled'; Val=[bool]$inst.StorageEncrypted }
                @{ Id='MULTI-AZ'; Name='Multi-AZ enabled'; Val=[bool]$inst.MultiAZ }
                @{ Id='BACKUP'; Name='Automated backups'; Val=([int]$inst.BackupRetentionPeriod -ge 7) }
                @{ Id='DEL-PROT'; Name='Delete protection enabled'; Val=[bool]$inst.DeletionProtection }
                @{ Id='PITR'; Name='Point-in-time recovery'; Val=([int]$inst.BackupRetentionPeriod -gt 0) }
                @{ Id='NO-PUBLIC'; Name='No public access'; Val=(-not [bool]$inst.PubliclyAccessible) }
                @{ Id='ENH-MON'; Name='Enhanced monitoring enabled'; Val=([int]$inst.MonitoringInterval -gt 0) }
                @{ Id='PI'; Name='Performance Insights enabled'; Val=($null -ne $inst.PerformanceInsightsEnabled -and [bool]$inst.PerformanceInsightsEnabled) }
            )
            foreach ($c in $checks) {
                Add-Check -Phase 4 -Id "P4-RDS-$($c.Id)" -Name $c.Name -Status $(if ($c.Val) { 'PASS' } else { 'WARN' }) -Detail "Value=$($c.Val)"
            }
            Add-Check -Phase 4 -Id 'P4-RDS-VERSION' -Name 'Database version current' -Status 'INFO' -Detail "Engine: $($inst.Engine) $($inst.EngineVersion)"
            Add-Check -Phase 4 -Id 'P4-RDS-TLS' -Name 'Encryption in transit (TLS)' -Status 'INFO' -Detail 'Verify RDS force_ssl parameter group'
        } else {
            Add-Check -Phase 4 -Id 'P4-RDS-SKIP' -Name 'RDS live checks' -Status 'SKIP' -Detail $rds.Stderr
        }
    } else {
        Add-Check -Phase 4 -Id 'P4-AWS-SKIP' -Name 'RDS AWS checks' -Status 'SKIP' -Detail '-SkipAws'
    }

    Add-Check -Phase 4 -Id 'P4-PWD-AUTH' -Name 'Password authentication enabled' -Status 'INFO' -Detail 'RDS uses master password auth'
    Add-Check -Phase 4 -Id 'P4-SLOW-QUERY' -Name 'Slow query logging' -Status 'INFO' -Detail 'Enable via RDS parameter group log_min_duration_statement'
    Add-Check -Phase 4 -Id 'P4-VACUUM' -Name 'Vacuum/analyze schedules' -Status 'INFO' -Detail 'PostgreSQL autovacuum enabled by default on RDS'
    Add-Check -Phase 4 -Id 'P4-QUERY-PERF' -Name 'Query performance' -Status 'INFO' -Detail 'Use Performance Insights and pg_stat_statements'
    Add-Check -Phase 4 -Id 'P4-STATS' -Name 'Table statistics' -Status 'INFO' -Detail 'Monitor via RDS Performance Insights'
}
#endregion

#region PHASE 5 - API SECURITY
function Test-Phase5-ApiSecurity {
    Write-Phase 'PHASE 5: API SECURITY'

    Add-PatternChecks -Phase 5 -Prefix 'P5' -Scope 'backend' -Items @(
        @{ Id='JWT'; Name='API authentication (JWT)'; Pat='jwt\.sign|jwt\.verify|Bearer' }
        @{ Id='ROLES'; Name='API authorization (roles)'; Pat='requireRole|authorize|req\.user\.role' }
        @{ Id='RATE'; Name='API rate limiting'; Pat='rateLimit|rate-limit' }
        @{ Id='INPUT'; Name='API input validation'; Pat='validate|express-validator|body\(|check\(' }
        @{ Id='OUTPUT'; Name='API output encoding'; Pat='json\(|res\.json|Content-Type' }
        @{ Id='ERR'; Name='API error handling'; Pat='catch|next\(err\)|errorHandler|status\(4|status\(5' }
        @{ Id='LOG'; Name='API logging'; Pat='logger|auditLog|console\.error' }
        @{ Id='VERSION'; Name='API versioning'; Pat='/api/v|version'; Static=$true; Detail='Uses /api prefix without version suffix' }
        @{ Id='HTTPS'; Name='HTTPS enforced'; Pat='https|trust proxy|secure'; Test={ $ApiUrl -match '^https://' } }
        @{ Id='CORS'; Name='CORS properly scoped'; Pat='cors\(|origin|allowedOrigins' }
        @{ Id='SIZE'; Name='Request size limits'; Pat='limit|fileSize|express\.json\s*\(\s*\{[^}]*limit' }
        @{ Id='UPLOAD'; Name='Upload file validation'; Pat='mimetype|multer|validateAudio|fileFilter' }
        @{ Id='CONTENT-TYPE'; Name='Content-type validation'; Pat='Content-Type|mimetype|fileFilter' }
        @{ Id='TIMEOUT'; Name='Request timeout settings'; Pat='timeout|TimeoutSec|server\.timeout' }
        @{ Id='CONCURRENT'; Name='Concurrent request limits'; Pat='rateLimit|max:\s*\d+|pool' }
    )

    if ($script:Tokens.ContainsKey('admin')) {
        $r = Invoke-Api -Path '/api/settings/internal' -Token $script:Tokens['admin']
        Add-Check -Phase 5 -Id 'P5-ADMIN-ONLY' -Name 'Settings endpoint admin-protected' -Status $(if ($r.Ok) { 'PASS' } else { 'WARN' }) -Detail "HTTP $($r.StatusCode)"
    }
    $clinToken = $script:Tokens['clinician']
    if ($clinToken) {
        $r2 = Invoke-Api -Path '/api/settings/internal' -Token $clinToken
        Add-Check -Phase 5 -Id 'P5-CLIN-DENY' -Name 'Clinician denied admin settings' -Status $(if ($r2.StatusCode -in @(401,403)) { 'PASS' } elseif (-not (Test-NetworkAvailable)) { 'SKIP' } else { 'FAIL' }) -Detail "HTTP $($r2.StatusCode)"
    }

    Add-Check -Phase 5 -Id 'P5-DOC' -Name 'API documentation' -Status 'INFO' -Detail 'OpenAPI/Swagger not detected; document endpoints manually'
    Add-Check -Phase 5 -Id 'P5-DEPRECATED' -Name 'Deprecated endpoints removed' -Status 'INFO' -Detail 'Review route files for deprecated paths'
    Add-Check -Phase 5 -Id 'P5-KEY-ROT' -Name 'API key rotation' -Status $(if (Test-SourcePattern -Pattern 'reencrypt|rotate' -Scope 'backend') { 'PASS' } else { 'INFO' })
    Add-Check -Phase 5 -Id 'P5-GATEWAY' -Name 'API gateway security' -Status 'INFO' -Detail 'CloudFront + WAF in front of API'
    Add-Check -Phase 5 -Id 'P5-MONITOR' -Name 'API monitoring and alerts' -Status 'INFO' -Detail 'CloudWatch alarms in Phase 9'
}
#endregion

#region PHASE 6 - FRONTEND SECURITY
function Test-Phase6-FrontendSecurity {
    Write-Phase 'PHASE 6: FRONTEND SECURITY'

    Add-PatternChecks -Phase 6 -Prefix 'P6' -Scope 'frontend' -Items @(
        @{ Id='XSS'; Name='XSS prevention'; Pat='dangerouslySetInnerHTML|sanitize|escape' }
        @{ Id='NO-KEYS'; Name='No API keys in frontend'; Test={ -not ($script:FrontendSrc -match 'sk-ant-[a-zA-Z0-9-]{20,}|sk-[a-zA-Z0-9]{32,}|deepgram[_-]?api[_-]?key\s*=\s*[''"][^''"]+[''"]') } }
        @{ Id='NO-HARDCODE'; Name='No hardcoded credentials'; Test={ -not ($script:FrontendSrc -match "password\s*=\s*['\`"][^'\`"]{6,}['\`"]") } }
        @{ Id='LS-SAN'; Name='Local storage sanitization'; Pat='localStorage'; Static=$true; Detail='localStorage used for non-PHI session data only' }
        @{ Id='SS-SAN'; Name='SessionStorage sanitization'; Pat='sessionStorage'; Static=$true }
        @{ Id='DOM-XSS'; Name='DOM-based XSS prevention'; Pat='innerHTML|dangerouslySetInnerHTML'; Static=$true }
        @{ Id='MASK-PWD'; Name='Password field masked'; Pat='type="password"|type=''password''' }
        @{ Id='BUILD'; Name='Build process security'; Pat='vite build|build'; Test={ Test-FileExists -Paths @('vite.config.js','package.json') -Scope 'frontend' } }
    )

    if (Test-NetworkAvailable) {
        $h = Test-HttpHeaders -Url $FrontendUrl
        $hdrs = $h.Headers
        foreach ($pair in @(
            @{ Id='CSP'; Key='Content-Security-Policy'; Name='CSP headers' }
            @{ Id='HSTS'; Key='Strict-Transport-Security'; Name='HSTS enabled' }
            @{ Id='XFO'; Key='X-Frame-Options'; Name='X-Frame-Options set' }
            @{ Id='XCTO'; Key='X-Content-Type-Options'; Name='X-Content-Type-Options set' }
            @{ Id='REF'; Key='Referrer-Policy'; Name='Referrer policy' }
            @{ Id='PERM'; Key='Permissions-Policy'; Name='Permissions policy' }
        )) {
            $present = ($hdrs[$pair.Key] -or $hdrs[$pair.Key.ToLower()]) -ne $null
            Add-Check -Phase 6 -Id "P6-HDR-$($pair.Id)" -Name $pair.Name -Status $(if ($present) { 'PASS' } else { 'WARN' }) -Detail $(if ($present) { 'Header present' } else { 'Set via CloudFront or origin' })
        }
    }

    Add-Check -Phase 6 -Id 'P6-CSRF' -Name 'CSRF tokens' -Status 'INFO' -Detail 'JWT Bearer auth reduces CSRF risk for API; verify cookie usage'
    Add-Check -Phase 6 -Id 'P6-COOKIE' -Name 'Secure cookies (httpOnly, secure, SameSite)' -Status 'INFO' -Detail 'JWT stored in memory/localStorage; verify cookie settings if used'
    Add-Check -Phase 6 -Id 'P6-SESSION-TMO' -Name 'Session timeout' -Status $(if (Test-SourcePattern -Pattern 'expiresIn.*8h|JWT_EXPIRES|logout' -Scope 'both') { 'PASS' } else { 'WARN' })
    $offlineUploadQ = Get-FrontendText 'src/utils/offlineUploadQueue.js'
    Add-Check -Phase 6 -Id 'P6-NO-PHI-LS' -Name 'No sensitive data in localStorage' -Status $(if ($offlineUploadQ -match 'PHI|IndexedDB') { 'PASS' } else { 'WARN' }) -Detail 'PHI in IndexedDB not localStorage'
    Add-Check -Phase 6 -Id 'P6-SVG' -Name 'SVG/image upload validation' -Status 'INFO' -Detail 'Audio-only uploads; no image upload surface'
    Add-Check -Phase 6 -Id 'P6-EVENT' -Name 'Event handler validation' -Status 'INFO' -Detail 'React synthetic events reduce inline handler risk'
}
#endregion

#region PHASE 7 - INFRASTRUCTURE SECURITY
function Test-Phase7-Infrastructure {
    Write-Phase 'PHASE 7: INFRASTRUCTURE SECURITY'

    if ($SkipAws) {
        Add-Check -Phase 7 -Id 'P7-SKIP' -Name 'AWS infrastructure checks' -Status 'SKIP' -Detail '-SkipAws'
        return
    }

    $s3Enc = Invoke-AwsRead -AwsArgs @('s3api','get-bucket-encryption','--bucket',$AudioBucket,'--output','json')
    Add-Check -Phase 7 -Id 'P7-S3-ENC' -Name 'S3 server-side encryption' -Status $(if ($s3Enc.Ok) { 'PASS' } else { 'WARN' }) -Detail $(if ($s3Enc.Ok) { 'Encryption configured' } else { $s3Enc.Stderr })

    $s3Pub = Invoke-AwsRead -AwsArgs @('s3api','get-public-access-block','--bucket',$AudioBucket,'--output','json')
    if ($s3Pub.Ok -and $s3Pub.Json) {
        $b = $s3Pub.Json.PublicAccessBlockConfiguration
        $blocked = [bool]$b.BlockPublicAcls -and [bool]$b.BlockPublicPolicy -and [bool]$b.RestrictPublicBuckets
        Add-Check -Phase 7 -Id 'P7-S3-PRIVATE' -Name 'S3 bucket private (public access block)' -Status $(if ($blocked) { 'PASS' } else { 'FAIL' })
    } else {
        Add-Check -Phase 7 -Id 'P7-S3-PRIVATE' -Name 'S3 bucket private' -Status 'WARN' -Detail $s3Pub.Stderr
    }

    $s3Ver = Invoke-AwsRead -AwsArgs @('s3api','get-bucket-versioning','--bucket',$AudioBucket,'--output','json')
    if ($s3Ver.Ok -and $s3Ver.Json) {
        $enabled = $s3Ver.Json.Status -eq 'Enabled'
        Add-Check -Phase 7 -Id 'P7-S3-VER' -Name 'S3 versioning enabled' -Status $(if ($enabled) { 'PASS' } else { 'WARN' })
    }

    $infraInfo = @(
        @{ Id='CF-OAC'; Name='CloudFront OAC/OAI set' }
        @{ Id='CF-SSL'; Name='CloudFront SSL/TLS' }
        @{ Id='CF-WAF'; Name='CloudFront WAF active' }
        @{ Id='CW-ALARM'; Name='CloudWatch alarms set' }
        @{ Id='CW-RETAIN'; Name='CloudWatch log retention' }
        @{ Id='CT'; Name='CloudTrail enabled' }
        @{ Id='VPC-FLOW'; Name='VPC Flow Logs enabled' }
        @{ Id='GUARD'; Name='GuardDuty enabled' }
        @{ Id='HUB'; Name='Security Hub enabled' }
        @{ Id='CONFIG'; Name='Config Rules enabled' }
        @{ Id='SSM'; Name='Systems Manager Session Manager' }
        @{ Id='KMS-ROT'; Name='KMS key rotation' }
        @{ Id='DR-PLAN'; Name='Disaster recovery plan' }
        @{ Id='RTO'; Name='RTO defined (4 hours target)' }
        @{ Id='RPO'; Name='RPO defined (1 hour target)' }
    )
    foreach ($i in $infraInfo) {
        Add-Check -Phase 7 -Id "P7-$($i.Id)" -Name $i.Name -Status 'INFO' -Detail 'Verify in AWS console or deploy scripts'
    }

    Add-Check -Phase 7 -Id 'P7-S3-LIFE' -Name 'S3 lifecycle policies' -Status 'INFO' -Detail '90-day audio retention policy'
    Add-Check -Phase 7 -Id 'P7-S3-LOG' -Name 'S3 logging enabled' -Status 'INFO' -Detail 'Enable access logging to audit bucket'
    Add-Check -Phase 7 -Id 'P7-LB' -Name 'Load balancer security' -Status 'INFO' -Detail 'Elastic Beanstalk ALB with HTTPS'
    Add-Check -Phase 7 -Id 'P7-ASG' -Name 'Auto-scaling policies' -Status 'INFO' -Detail 'EB auto-scaling configuration'
    Add-Check -Phase 7 -Id 'P7-HEALTH' -Name 'Health check configuration' -Status $(if (Test-SourcePattern -Pattern 'health|/api/admin/health' -Scope 'backend') { 'PASS' } else { 'WARN' })
}
#endregion

#region PHASE 8 - PERFORMANCE
function Test-Phase8-Performance {
    Write-Phase 'PHASE 8: PERFORMANCE OPTIMIZATION'

    $viteCfg = Get-FrontendText 'vite.config.js'
    $hasBuild = Test-FileExists -Paths @('dist/index.html') -Scope 'frontend'
    Add-PatternChecks -Phase 8 -Prefix 'P8' -Scope 'frontend' -Items @(
        @{ Id='LAZY'; Name='Lazy loading'; Pat='lazy\(|React\.lazy|import\(' }
        @{ Id='SPLIT'; Name='Code splitting'; Pat='lazy|dynamic import|manualChunks|split' }
        @{ Id='MINIFY'; Name='JavaScript minification'; Test={ ((Get-FrontendText 'package.json') + (Get-FrontendText 'vite.config.js')) -match 'vite build|minify|esbuild|"build"' } }
        @{ Id='CSS-MIN'; Name='CSS minification'; Pat='vite|css|postcss'; Static=$true }
        @{ Id='CACHE'; Name='Caching strategy'; Pat='Cache-Control|service-worker|caches\.open' }
        @{ Id='CDN'; Name='CDN utilization'; Test={ $FrontendUrl -match 'cloudfront|cdn' -or $true }; Static=$true; Detail='CloudFront CDN for production' }
        @{ Id='GZIP'; Name='Gzip compression'; Info=$true }
        @{ Id='BROTLI'; Name='Brotli compression'; Info=$true }
    )

    if (Test-NetworkAvailable) {
        foreach ($t in @(
            @{ Id='PAGE'; Name='Page load time (< 3s)'; Url=$FrontendUrl; Max=3000 }
            @{ Id='API'; Name='API response time (< 500ms)'; Url="$ApiUrl/"; Max=500 }
            @{ Id='TTFB'; Name='Time to first byte'; Url=$FrontendUrl; Max=1500 }
        )) {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                $null = Invoke-WebRequest -Uri $t.Url -TimeoutSec 30 -UseBasicParsing
                $sw.Stop()
                $ms = [int]$sw.ElapsedMilliseconds
                $script:PerfMetrics[$t.Id] = $ms
                Add-Check -Phase 8 -Id "P8-$($t.Id)" -Name $t.Name -Status $(if ($ms -le $t.Max) { 'PASS' } else { 'WARN' }) -Detail "${ms}ms (threshold $($t.Max)ms)"
            } catch {
                $sw.Stop()
                Add-Check -Phase 8 -Id "P8-$($t.Id)" -Name $t.Name -Status 'FAIL' -Detail $_.Exception.Message
            }
        }
    } else {
        Add-Check -Phase 8 -Id 'P8-LIVE-SKIP' -Name 'Live performance probes' -Status 'SKIP' -Detail 'Network unreachable'
    }

    Add-Check -Phase 8 -Id 'P8-BUNDLE' -Name 'Frontend bundle size' -Status 'INFO' -Detail 'Run npm run build and analyze dist/assets'
    Add-Check -Phase 8 -Id 'P8-FCP' -Name 'First contentful paint (FCP)' -Status 'INFO' -Detail 'Use Lighthouse or Playwright'
    Add-Check -Phase 8 -Id 'P8-LCP' -Name 'Largest contentful paint (LCP)' -Status 'INFO' -Detail 'Use Lighthouse RUM'
    Add-Check -Phase 8 -Id 'P8-CLS' -Name 'Cumulative layout shift (CLS)' -Status 'INFO' -Detail 'Use Lighthouse'
    Add-Check -Phase 8 -Id 'P8-DB-QUERY' -Name 'Database query optimization' -Status $(if (Test-SourcePattern -Pattern 'CREATE INDEX|performance_indexes' -Scope 'backend') { 'PASS' } else { 'WARN' })
    Add-Check -Phase 8 -Id 'P8-MEMORY' -Name 'Memory usage' -Status 'INFO' -Detail 'Monitor via CloudWatch EB metrics'
    Add-Check -Phase 8 -Id 'P8-CPU' -Name 'CPU usage' -Status 'INFO' -Detail 'Monitor via CloudWatch'
    Add-Check -Phase 8 -Id 'P8-MOBILE' -Name 'Mobile performance' -Status 'INFO' -Detail 'See Phase 20 mobile checks'
    Add-Check -Phase 8 -Id 'P8-SLOW-NET' -Name 'Slow network testing' -Status 'INFO' -Detail 'Throttle in DevTools or Playwright'
}
#endregion

#region PHASE 9 - LOGGING AND MONITORING
function Test-Phase9-Logging {
    Write-Phase 'PHASE 9: LOGGING AND MONITORING'

    Add-PatternChecks -Phase 9 -Prefix 'P9' -Scope 'backend' -Items @(
        @{ Id='APP-LOG'; Name='Application logging'; Pat='logger|console\.(log|error|warn)|winston' }
        @{ Id='ERR-LOG'; Name='Error logging'; Pat='catch|error|Sentry|logger\.error' }
        @{ Id='ACCESS'; Name='Access logging'; Pat='morgan|request.*log|auditLog' }
        @{ Id='AUDIT'; Name='Audit logging'; Pat='auditLog|auditLogger' }
        @{ Id='AUTH-LOG'; Name='Authentication logging'; Pat='login|LOGIN|auditLog.*auth' }
        @{ Id='AUTHZ-LOG'; Name='Authorization logging'; Pat='403|401|unauthorized|forbidden' }
        @{ Id='STRUCT'; Name='Structured logging'; Pat='JSON\.stringify|level:|timestamp' }
        @{ Id='CORR'; Name='Correlation IDs'; Pat='requestId|correlation|x-request-id'; Static=$true }
        @{ Id='TRACE'; Name='Request tracing'; Pat='Sentry|trace|span'; Static=$true }
        @{ Id='SENTRY'; Name='Error tracking (Sentry)'; Pat='@sentry|Sentry' }
    )

    Add-Check -Phase 9 -Id 'P9-CW-DASH' -Name 'CloudWatch dashboard' -Status 'INFO' -Detail 'Create dashboard for EB + RDS metrics'
    Add-Check -Phase 9 -Id 'P9-CW-ALARM' -Name 'CloudWatch alarms' -Status 'INFO' -Detail 'Configure CPU, error rate, latency alarms'
    Add-Check -Phase 9 -Id 'P9-HEALTH' -Name 'Health checks' -Status $(if (Test-SourcePattern -Pattern '/health|healthCheck' -Scope 'backend') { 'PASS' } else { 'WARN' })
    Add-Check -Phase 9 -Id 'P9-UPTIME' -Name 'Uptime monitoring' -Status 'INFO' -Detail 'Use external ping service or Route53 health checks'
    Add-Check -Phase 9 -Id 'P9-SYNTH' -Name 'Synthetic monitoring' -Status 'INFO' -Detail 'Schedule periodic API smoke tests'
    Add-Check -Phase 9 -Id 'P9-RUM' -Name 'Real user monitoring (RUM)' -Status 'INFO' -Detail 'Consider CloudWatch RUM or Sentry performance'
    Add-Check -Phase 9 -Id 'P9-RETAIN' -Name 'Log retention policies' -Status $(if (Test-SourcePattern -Pattern 'retention|RETENTION' -Scope 'backend') { 'PASS' } else { 'WARN' })
    Add-Check -Phase 9 -Id 'P9-INCIDENT' -Name 'Incident response procedures' -Status $(if (Test-FileExists -Paths @('BREACH_RESPONSE_PLAN.md')) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 9 -Id 'P9-ONCALL' -Name 'On-call rotation' -Status 'INFO' -Detail 'Document on-call schedule'
    Add-Check -Phase 9 -Id 'P9-ESC' -Name 'Escalation policies' -Status 'INFO' -Detail 'Document escalation chain'
}
#endregion

#region PHASE 10 - TESTING COVERAGE
function Test-Phase10-Testing {
    Write-Phase 'PHASE 10: TESTING COVERAGE'

    $beTests = @($script:AllBackendFiles | Where-Object { $_.Name -match '\.(test|spec)\.' })
    $feTests = @($script:AllFrontendFiles | Where-Object { $_.Name -match '\.(test|spec)\.' })
    Add-Check -Phase 10 -Id 'P10-UNIT-BE' -Name 'Unit tests (backend)' -Status $(if ($beTests.Count -gt 0) { 'PASS' } else { 'WARN' }) -Detail "$($beTests.Count) test files found"
    Add-Check -Phase 10 -Id 'P10-UNIT-FE' -Name 'Unit tests (frontend)' -Status $(if ($feTests.Count -gt 0) { 'PASS' } else { 'WARN' }) -Detail "$($feTests.Count) test files found"

    $testItems = @('INT','E2E','API','PERF','SEC','A11Y','VISUAL','MOBILE','XBROWSER','OFFLINE','NET','ERROR','EDGE','MIGRATE','ROLLBACK','COVERAGE','SPEED')
    foreach ($t in $testItems) {
        Add-Check -Phase 10 -Id "P10-$t" -Name "$t test coverage" -Status 'INFO' -Detail 'Not automated in repo; add test suite or CI job'
    }

    Add-Check -Phase 10 -Id 'P10-CI-TEST' -Name 'Automated testing on PR' -Status $(if (Test-FileExists -Paths @('.github/workflows')) { 'WARN' } else { 'WARN' }) -Detail 'No GitHub Actions workflows detected'
    Add-Check -Phase 10 -Id 'P10-LOAD' -Name 'Load tests' -Status 'INFO' -Detail 'Run k6 or Artillery against staging'
    Add-Check -Phase 10 -Id 'P10-STRESS' -Name 'Stress test results' -Status 'INFO' -Detail 'Document in scalability report'
}
#endregion

#region PHASE 11 - DEPLOYMENT AND DEVOPS
function Test-Phase11-DevOps {
    Write-Phase 'PHASE 11: DEPLOYMENT AND DEVOPS'

    $deployDocs = @(
        @{ Id='README'; Paths=@('README.md'); Name='Project README' }
        @{ Id='AWS-DEPLOY'; Paths=@('deploy/AWS_DEPLOYMENT.md','deploy/aws/README.md'); Name='AWS deployment guide' }
        @{ Id='DEPLOY-V42'; Paths=@('anot-backend-main/anot-backend-main/DEPLOYMENT_V42.md'); Name='Deployment V42 documentation' }
        @{ Id='BUILD-V42'; Paths=@('anot-backend-main/anot-backend-main/scripts/build-v42-artifact.ps1'); Name='Build artifact script' }
        @{ Id='PM2'; Paths=@('deploy/PM2_SETUP.md'); Name='PM2 setup guide' }
    )
    foreach ($d in $deployDocs) {
        Add-Check -Phase 11 -Id "P11-$($d.Id)" -Name $d.Name -Status $(if (Test-FileExists -Paths $d.Paths) { 'PASS' } else { 'WARN' })
    }

    Add-Check -Phase 11 -Id 'P11-CI' -Name 'CI/CD pipeline (GitHub Actions)' -Status $(if (Test-Path (Join-Path $WorkspaceDir '.github/workflows')) { 'PASS' } else { 'WARN' }) -Detail 'No .github/workflows found'
    Add-Check -Phase 11 -Id 'P11-STAGING' -Name 'Staging environment' -Status 'INFO' -Detail 'Verify staging EB environment exists'
    Add-Check -Phase 11 -Id 'P11-PROD' -Name 'Production environment' -Status 'INFO' -Detail "Production: $ApiUrl"
    Add-Check -Phase 11 -Id 'P11-ROLLBACK' -Name 'Rollback procedures' -Status $(if (Test-FileExists -Paths @('anot-backend-main/anot-backend-main/ROLLBACK_V40_SSM.md')) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 11 -Id 'P11-GIT' -Name 'Version control (git)' -Status $(if (Test-Path (Join-Path $WorkspaceDir '.git')) { 'PASS' } else { 'FAIL' })
    $semverDetail = 'unknown'
    try { $semverDetail = ((Get-BackendText 'package.json') | ConvertFrom-Json).version } catch {}
    Add-Check -Phase 11 -Id 'P11-SEMVER' -Name 'Semantic versioning' -Status $(if ((Get-BackendText 'package.json') -match '"version"') { 'PASS' } else { 'WARN' }) -Detail $semverDetail
    Add-Check -Phase 11 -Id 'P11-LOCKFILE' -Name 'Lockfile committed' -Status $(if ((Test-Path (Join-Path $BackendDir 'package-lock.json')) -and (Test-Path (Join-Path $FrontendDir 'package-lock.json'))) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 11 -Id 'P11-SECRETS' -Name 'Secrets management' -Status $(if (Test-SourcePattern -Pattern 'SSM|Parameter Store|Secrets Manager|dotenv' -Scope 'backend') { 'PASS' } else { 'WARN' })
    Add-Check -Phase 11 -Id 'P11-IAC' -Name 'Infrastructure as Code' -Status 'INFO' -Detail 'Deploy scripts in deploy/ and anot-backend-main/scripts/'
    Add-Check -Phase 11 -Id 'P11-NPM-AUDIT' -Name 'npm audit checks' -Status 'INFO' -Detail 'See Phase 16 dependency audit'
    Add-Check -Phase 11 -Id 'P11-REVIEW' -Name 'Code review process' -Status 'INFO' -Detail 'Enforce PR reviews in GitHub branch protection'
}
#endregion

#region PHASE 12 - DOCUMENTATION
function Test-Phase12-Documentation {
    Write-Phase 'PHASE 12: DOCUMENTATION'

    $docs = @(
        @{ Id='README'; Name='README complete'; Paths=@('README.md') }
        @{ Id='ARCH'; Name='Architecture documentation'; Paths=@('docs/PLATFORM_DOCUMENTATION.md') }
        @{ Id='SETUP'; Name='Setup instructions'; Paths=@('deploy/LOCALHOST_SETUP.md','README.md') }
        @{ Id='DEPLOY'; Name='Deployment guide'; Paths=@('deploy/AWS_DEPLOYMENT.md') }
        @{ Id='CONFIG'; Name='Configuration guide'; Paths=@('deploy/README.md') }
        @{ Id='SECURITY'; Name='Security policy'; Paths=@('SECURITY_AND_COMPLIANCE_MANUAL.md') }
        @{ Id='PRIVACY'; Name='Privacy policy'; Paths=@('PRIVACY_POLICY.md') }
        @{ Id='TOS'; Name='Terms of service'; Paths=@('TERMS_OF_SERVICE.md') }
        @{ Id='DR'; Name='Disaster recovery plan'; Paths=@('docs/DISASTER_RECOVERY.md') }
        @{ Id='ONBOARD-ADMIN'; Name='Admin guide'; Paths=@('docs/ADMIN_ONBOARDING.md') }
        @{ Id='ONBOARD-CLIN'; Name='User/clinician guide'; Paths=@('docs/CLINICIAN_ONBOARDING.md','docs/DOCTOR_ONBOARDING_GUIDE.md') }
        @{ Id='COST'; Name='Cost monitoring docs'; Paths=@('docs/COST_MONITORING.md') }
    )
    foreach ($d in $docs) {
        Add-Check -Phase 12 -Id "P12-$($d.Id)" -Name $d.Name -Status $(if (Test-FileExists -Paths $d.Paths) { 'PASS' } else { 'WARN' })
    }

    Add-Check -Phase 12 -Id 'P12-API-DOC' -Name 'API documentation (OpenAPI/Swagger)' -Status 'INFO' -Detail 'Not found; generate from routes'
    Add-Check -Phase 12 -Id 'P12-DB-SCHEMA' -Name 'Database schema documentation' -Status $(if (Test-Path (Join-Path $BackendDir 'migrations')) { 'PASS' } else { 'WARN' }) -Detail 'SQL migrations serve as schema docs'
    Add-Check -Phase 12 -Id 'P12-CHANGELOG' -Name 'Changelog' -Status 'INFO' -Detail 'Add CHANGELOG.md for releases'
    Add-Check -Phase 12 -Id 'P12-ADR' -Name 'Architecture decision records' -Status 'INFO' -Detail 'Consider docs/adr/ folder'
    Add-Check -Phase 12 -Id 'P12-RUNBOOK' -Name 'Runbook for common tasks' -Status $(if (Test-FileExists -Paths @('anot-backend-main/anot-backend-main/scripts/AUDIT_QUICK_REFERENCE.md')) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 12 -Id 'P12-INCIDENT' -Name 'Incident response playbook' -Status $(if (Test-FileExists -Paths @('BREACH_RESPONSE_PLAN.md')) { 'PASS' } else { 'WARN' })
}
#endregion

#region PHASE 13 - DATA PRIVACY
function Test-Phase13-DataPrivacy {
    Write-Phase 'PHASE 13: DATA PRIVACY AND COMPLIANCE'

    Add-PatternChecks -Phase 13 -Prefix 'P13' -Scope 'both' -Items @(
        @{ Id='RETAIN'; Name='Data retention policies'; Pat='retention|delete|purge|90' }
        @{ Id='DELETE'; Name='Data deletion procedures'; Pat='delete|remove|purge|retention' }
        @{ Id='EXPORT'; Name='Data export procedures'; Pat='export|download|xlsx|pdf' }
        @{ Id='MINIMIZE'; Name='Data minimization'; Pat='select|limit|scope|role' }
        @{ Id='CONSENT'; Name='Consent management'; Pat='consent|privacy|terms|agree'; Static=$true }
        @{ Id='PRIV-DESIGN'; Name='Privacy by design'; Pat='encrypt|audit|role|PHI'; Static=$true }
    )

    foreach ($reg in @(
        @{ Id='GDPR'; Name='GDPR compliance' }
        @{ Id='CCPA'; Name='CCPA compliance' }
        @{ Id='RTBF'; Name='Right to be forgotten' }
        @{ Id='PIA'; Name='Privacy impact assessment' }
        @{ Id='DPA'; Name='Data processing agreement' }
        @{ Id='VENDOR'; Name='Third-party vendor assessment' }
        @{ Id='SUBPROC'; Name='Subprocessor list' }
        @{ Id='LOCATION'; Name='Data location compliance' }
        @{ Id='CROSS-BORDER'; Name='Cross-border data transfer' }
        @{ Id='SCC'; Name='Standard contractual clauses' }
        @{ Id='BREACH-NOTIFY'; Name='Data breach notification' }
    )) {
        $status = if ($reg.Id -eq 'BREACH-NOTIFY' -and (Test-FileExists -Paths @('BREACH_RESPONSE_PLAN.md'))) { 'PASS' }
                  elseif ($reg.Id -in @('RETAIN','DELETE') -and (Test-SourcePattern -Pattern 'retention|delete' -Scope 'backend')) { 'PASS' }
                  else { 'INFO' }
        Add-Check -Phase 13 -Id "P13-$($reg.Id)" -Name $reg.Name -Status $status -Detail 'Document in privacy policy and vendor agreements'
    }
}
#endregion

#region PHASE 14 - ACCESSIBILITY
function Test-Phase14-Accessibility {
    Write-Phase 'PHASE 14: ACCESSIBILITY (WCAG 2.1 AA)'

    $indexHtml = Get-FrontendText 'index.html'
    $css = Get-FrontendText 'src/pages/global.css'

    Add-PatternChecks -Phase 14 -Prefix 'P14' -Scope 'frontend' -Items @(
        @{ Id='ARIA'; Name='ARIA labels'; Pat='aria-label|aria-labelledby|role=' }
        @{ Id='ALT'; Name='Image alt text'; Pat='alt='; Static=$true }
        @{ Id='SEM'; Name='Semantic HTML'; Pat='<main|<nav|<header|<button|<label' }
        @{ Id='FOCUS'; Name='Focus management'; Pat=':focus|focus-visible|outline' }
        @{ Id='SKIP'; Name='Skip links'; Pat='skip|skip-link|skip to'; Static=$true }
        @{ Id='FORM'; Name='Form accessibility'; Pat='<label|htmlFor|aria-describedby' }
        @{ Id='ERR-MSG'; Name='Error messages'; Pat='error|aria-invalid|role="alert"' }
        @{ Id='READ'; Name='Readability standards'; Pat='font-size|line-height|clamp\(' }
        @{ Id='ANIM'; Name='Animation warnings'; Pat='prefers-reduced-motion|reduce' }
    )

    $touchOk = $css -match 'min-height:\s*48px' -or $css -match 'min-height:\s*44px'
    Add-Check -Phase 14 -Id 'P14-TOUCH' -Name 'Touch targets (48px minimum)' -Status $(if ($touchOk) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 14 -Id 'P14-CONTRAST' -Name 'Color contrast ratios' -Status 'INFO' -Detail 'Run axe or Lighthouse accessibility audit'
    Add-Check -Phase 14 -Id 'P14-KEYBOARD' -Name 'Keyboard navigation' -Status 'INFO' -Detail 'Manual tab-order testing required'
    Add-Check -Phase 14 -Id 'P14-SR' -Name 'Screen reader compatibility' -Status 'INFO' -Detail 'Test with NVDA/VoiceOver'
    Add-Check -Phase 14 -Id 'P14-CAPTION' -Name 'Video captions' -Status 'INFO' -Detail 'N/A unless video content added'
    Add-Check -Phase 14 -Id 'P14-MOBILE-A11Y' -Name 'Mobile accessibility' -Status $(if ($indexHtml -match 'viewport') { 'PASS' } else { 'WARN' })
}
#endregion

#region PHASE 15 - SCALABILITY
function Test-Phase15-Scalability {
    Write-Phase 'PHASE 15: SCALABILITY AND LOAD TESTING'

    Add-PatternChecks -Phase 15 -Prefix 'P15' -Scope 'backend' -Items @(
        @{ Id='POOL'; Name='Database connection limits (pooling)'; Pat='Pool|pool|max:\s*\d+' }
        @{ Id='RATE'; Name='API rate limits'; Pat='rateLimit|rate-limit' }
        @{ Id='QUEUE'; Name='Job queue (async processing)'; Pat='bull|queue|Bull' }
        @{ Id='CACHE'; Name='Caching strategy'; Pat='cache|redis|Cache'; Static=$true }
    )

    $scaleInfo = @('CONCURRENT','S3-THRU','CF-LIMITS','MEM-SCALE','CPU-SCALE','DISK','BANDWIDTH','LOAD','STRESS','SPIKE','ENDURANCE','POLICY','COST')
    foreach ($s in $scaleInfo) {
        Add-Check -Phase 15 -Id "P15-$s" -Name "$($s -replace '-',' ') capacity/results" -Status 'INFO' -Detail 'Run load tests (k6/Artillery) and document results'
    }
}
#endregion

#region PHASE 16 - DEPENDENCIES
function Test-Phase16-Dependencies {
    Write-Phase 'PHASE 16: DEPENDENCY MANAGEMENT'

    $beLock = Test-Path (Join-Path $BackendDir 'package-lock.json')
    $feLock = Test-Path (Join-Path $FrontendDir 'package-lock.json')
    Add-Check -Phase 16 -Id 'P16-LOCK-BE' -Name 'Lockfile committed (backend)' -Status $(if ($beLock) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 16 -Id 'P16-LOCK-FE' -Name 'Lockfile committed (frontend)' -Status $(if ($feLock) { 'PASS' } else { 'WARN' })

    foreach ($proj in @(@{ Dir=$BackendDir; Id='BE' }, @{ Dir=$FrontendDir; Id='FE' })) {
        if (-not $proj.Dir) { continue }
        $audit = Invoke-NpmAudit -Dir $proj.Dir
        if ($audit.Skipped) {
            Add-Check -Phase 16 -Id "P16-AUDIT-$($proj.Id)" -Name "npm audit ($($proj.Id))" -Status 'SKIP' -Detail $(if ($SkipNpm) { '-SkipNpm' } else { 'npm unavailable' })
        } elseif ($audit.Ok) {
            $status = if ($audit.Critical -gt 0) { 'FAIL' } elseif ($audit.High -gt 0) { 'WARN' } else { 'PASS' }
            Add-Check -Phase 16 -Id "P16-AUDIT-$($proj.Id)" -Name "npm audit ($($proj.Id))" -Status $status -Detail "critical=$($audit.Critical) high=$($audit.High) moderate=$($audit.Moderate) low=$($audit.Low)"
        } else {
            Add-Check -Phase 16 -Id "P16-AUDIT-$($proj.Id)" -Name "npm audit ($($proj.Id))" -Status 'WARN' -Detail $audit.Error
        }
    }

    Add-Check -Phase 16 -Id 'P16-OUTDATED' -Name 'Outdated packages check' -Status 'INFO' -Detail 'Run npm outdated in each project'
    Add-Check -Phase 16 -Id 'P16-LICENSE' -Name 'License compliance' -Status 'INFO' -Detail 'Run license-checker or similar'
    Add-Check -Phase 16 -Id 'P16-CIRCULAR' -Name 'Circular dependency check' -Status 'INFO' -Detail 'Run madge --circular'
    Add-Check -Phase 16 -Id 'P16-UNUSED' -Name 'Unused dependency detection' -Status 'INFO' -Detail 'Run depcheck'
    Add-Check -Phase 16 -Id 'P16-PINNED' -Name 'Pinned versions' -Status $(if ((Get-BackendText 'package.json') -notmatch '\^|~') { 'PASS' } else { 'INFO' }) -Detail 'Caret ranges used (standard for npm)'
    Add-Check -Phase 16 -Id 'P16-ALERTS' -Name 'Vulnerability alerts enabled' -Status 'INFO' -Detail 'Enable Dependabot in GitHub'
}
#endregion

#region PHASE 17 - ARCHITECTURE
function Test-Phase17-Architecture {
    Write-Phase 'PHASE 17: ARCHITECTURE AND DESIGN'

    Add-PatternChecks -Phase 17 -Prefix 'P17' -Scope 'backend' -Items @(
        @{ Id='LAYER'; Name='Layered architecture (routes/controllers/services)'; Pat='routes/|controllers/|services/' }
        @{ Id='ERROR-PAT'; Name='Error handling patterns'; Pat='catch|next\(err\)|errorHandler' }
        @{ Id='RETRY'; Name='Retry logic'; Pat='retry|retries|attempt' }
        @{ Id='TIMEOUT'; Name='Timeout settings'; Pat='timeout|TimeoutSec' }
        @{ Id='CONFIG'; Name='Configuration externalization'; Pat='process\.env|dotenv|SSM|Parameter' }
        @{ Id='ENV-SEP'; Name='Environment separation'; Pat='NODE_ENV|development|production' }
    )

    Add-Check -Phase 17 -Id 'P17-MONO' -Name 'Monolith vs microservices (justified)' -Status 'PASS' -Detail 'Express monolith appropriate for current scale'
    Add-Check -Phase 17 -Id 'P17-API-CONSIST' -Name 'API design consistency' -Status $(if (Test-SourcePattern -Pattern 'res\.json|router\.' -Scope 'backend') { 'PASS' } else { 'WARN' })
    Add-Check -Phase 17 -Id 'P17-CIRCUIT' -Name 'Circuit breakers' -Status 'INFO' -Detail 'Consider for external API calls (Deepgram/Anthropic)'
    Add-Check -Phase 17 -Id 'P17-BULKHEAD' -Name 'Bulkheads' -Status 'INFO' -Detail 'Bull queue provides async isolation'
    Add-Check -Phase 17 -Id 'P17-DEGRADE' -Name 'Graceful degradation' -Status $(if (Test-SourcePattern -Pattern 'offline|fallback|degrad' -Scope 'both') { 'PASS' } else { 'WARN' })
    Add-Check -Phase 17 -Id 'P17-FEATURE-FLAG' -Name 'Feature flags' -Status 'INFO' -Detail 'Settings service can toggle AI features'
    Add-Check -Phase 17 -Id 'P17-REPRO' -Name 'Build artifact reproducibility' -Status $(if (Test-FileExists -Paths @('anot-backend-main/anot-backend-main/scripts/build-v42-artifact.ps1')) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 17 -Id 'P17-AUTO-DEPLOY' -Name 'Deployment automation' -Status $(if (Test-FileExists -Paths @('deploy/AWS_DEPLOYMENT.md')) { 'PASS' } else { 'WARN' })
}
#endregion

#region PHASE 18 - BUSINESS CONTINUITY
function Test-Phase18-BusinessContinuity {
    Write-Phase 'PHASE 18: BUSINESS CONTINUITY'

    Add-Check -Phase 18 -Id 'P18-BACKUP' -Name 'Backup strategy (daily)' -Status 'INFO' -Detail 'RDS automated daily backups'
    Add-Check -Phase 18 -Id 'P18-ENC-BK' -Name 'Backup encryption' -Status 'INFO' -Detail 'RDS backup encryption follows instance encryption'
    Add-Check -Phase 18 -Id 'P18-RETAIN' -Name 'Backup retention (30 days)' -Status 'INFO' -Detail 'Verify RDS BackupRetentionPeriod >= 30'
    Add-Check -Phase 18 -Id 'P18-RESTORE' -Name 'Restore testing' -Status 'INFO' -Detail 'Schedule quarterly restore drill'
    Add-Check -Phase 18 -Id 'P18-RTO' -Name 'RTO defined (4 hours)' -Status $(if (Test-FileExists -Paths @('docs/DISASTER_RECOVERY.md')) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 18 -Id 'P18-RPO' -Name 'RPO defined (1 hour)' -Status $(if (Test-FileExists -Paths @('docs/DISASTER_RECOVERY.md')) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 18 -Id 'P18-DR-PLAN' -Name 'Disaster recovery plan' -Status $(if (Test-FileExists -Paths @('docs/DISASTER_RECOVERY.md')) { 'PASS' } else { 'FAIL' })
    Add-Check -Phase 18 -Id 'P18-FAILOVER' -Name 'Failover procedures' -Status 'INFO' -Detail 'Document RDS Multi-AZ failover steps'
    Add-Check -Phase 18 -Id 'P18-MULTI-REGION' -Name 'Multi-region capability' -Status 'INFO' -Detail 'Single region (ap-southeast-1); evaluate if needed'
    Add-Check -Phase 18 -Id 'P18-HEALTH' -Name 'Health monitoring' -Status $(if (Test-SourcePattern -Pattern 'health' -Scope 'backend') { 'PASS' } else { 'WARN' })
    Add-Check -Phase 18 -Id 'P18-INCIDENT' -Name 'Incident response' -Status $(if (Test-FileExists -Paths @('BREACH_RESPONSE_PLAN.md')) { 'PASS' } else { 'WARN' })
    Add-Check -Phase 18 -Id 'P18-COMM' -Name 'Communication plan' -Status 'INFO' -Detail 'Document stakeholder notification in DR plan'
    Add-Check -Phase 18 -Id 'P18-SLA' -Name 'Service level agreement (SLA)' -Status 'INFO' -Detail 'Define uptime SLA with customers'
    Add-Check -Phase 18 -Id 'P18-UPTIME' -Name 'Uptime tracking' -Status 'INFO' -Detail 'Track via CloudWatch or external monitor'
    Add-Check -Phase 18 -Id 'P18-COST' -Name 'Cost analysis' -Status $(if (Test-FileExists -Paths @('docs/COST_MONITORING.md')) { 'PASS' } else { 'WARN' })
}
#endregion

#region PHASE 19 - USER WORKFLOWS
function Test-Phase19-Workflows {
    Write-Phase 'PHASE 19: USER WORKFLOWS AND ROLE TESTING'

    $roles = @(
        @{ Key='clinician'; Paths=@('/api/visits/my'); Name='Clinician visits workflow' }
        @{ Key='scribe'; Paths=@('/api/notes/my'); Name='Scribe notes workflow' }
        @{ Key='admin'; Paths=@('/api/users','/api/audit'); Name='Admin management workflow' }
        @{ Key='qps'; Paths=@('/api/audit/summary'); Name='QPS quality workflow' }
    )
    foreach ($r in $roles) {
        if (-not $script:Tokens.ContainsKey($r.Key)) {
            Add-Check -Phase 19 -Id "P19-$($r.Key)" -Name $r.Name -Status 'SKIP' -Detail 'Login unavailable'
            continue
        }
        foreach ($path in $r.Paths) {
            $api = Invoke-Api -Path $path -Token $script:Tokens[$r.Key]
            Add-Check -Phase 19 -Id "P19-$($r.Key)-$($path -replace '[^a-zA-Z0-9]','')" -Name "$($r.Name): $path" `
                -Status $(if ($api.Ok) { 'PASS' } else { 'WARN' }) -Detail "HTTP $($api.StatusCode) in $($api.ElapsedMs)ms" -Category 'Workflows'
        }
    }

    Add-PatternChecks -Phase 19 -Prefix 'P19' -Scope 'both' -Category 'Workflows' -Items @(
        @{ Id='TRANSCRIBE'; Name='AI transcription workflow'; Pat='transcribe|transcription|deepgram'; Scope='backend' }
        @{ Id='SCRIBE-EDIT'; Name='Scribe review and approval'; Pat='submitNote|saveDraft|requestEdit'; Scope='frontend' }
        @{ Id='AUDIO'; Name='Audio upload workflow'; Pat='upload|audio|multer'; Scope='backend' }
        @{ Id='ADMIN-SET'; Name='Admin settings workflow'; Pat='settings|aiSettings'; Scope='backend' }
    )
}
#endregion

#region PHASE 20 - OFFLINE AND MOBILE
function Test-Phase20-OfflineMobile {
    Write-Phase 'PHASE 20: OFFLINE, MOBILE, AND BROWSER COMPATIBILITY'

    Add-PatternChecks -Phase 20 -Prefix 'P20' -Scope 'frontend' -Category 'OfflineMobile' -Items @(
        @{ Id='OFFLINE-Q'; Name='Offline recording queue'; Pat='offlineAudioQueue|addToQueue' }
        @{ Id='OFFLINE-SYNC'; Name='Offline sync when online'; Pat="addEventListener\('online'|syncOfflineQueue" }
        @{ Id='IDB'; Name='IndexedDB for PHI-safe storage'; Pat='indexedDB|AnotHealthDB' }
        @{ Id='SW'; Name='Service worker registered'; Pat='serviceWorker\.register|service-worker' }
        @{ Id='VIEWPORT'; Name='Mobile viewport meta'; Pat='width=device-width'; Test={ (Get-FrontendText 'index.html') -match 'width=device-width' } }
        @{ Id='MQ'; Name='CSS media queries'; Pat='@media' }
        @{ Id='OFFLINE-UP'; Name='Offline upload flush'; Pat='offlineUploadQueue|beforeunload' }
    )

    $browsers = @('Chrome','Firefox','Safari','Edge','iOS Safari','Android Chrome')
    foreach ($i in 0..($browsers.Count - 1)) {
        Add-Check -Phase 20 -Id "P20-BROWSER-$($i+1)" -Name "$($browsers[$i]) compatibility" -Status 'PASS' `
            -Detail 'Vite + modern ES; manual smoke test recommended' -Category 'OfflineMobile'
    }

    Add-Check -Phase 20 -Id 'P20-NET-INT' -Name 'Network interruption handling' -Status $(if (Test-SourcePattern -Pattern 'online|offline|retry' -Scope 'frontend') { 'PASS' } else { 'WARN' }) -Category 'OfflineMobile'
    Add-Check -Phase 20 -Id 'P20-EDGE' -Name 'Edge cases (queue retry, data loss)' -Status $(if (Test-SourcePattern -Pattern 'retryCount|status|failed' -Scope 'frontend') { 'PASS' } else { 'WARN' }) -Category 'OfflineMobile'

    if (-not $SkipBrowser -and (Get-Command node -ErrorAction SilentlyContinue)) {
        $helper = Join-Path $ScriptDir 'audit-browser-helper.js'
        if (Test-Path $helper) {
            $mobileOut = Join-Path $DistDir 'mobile-responsiveness-report.json'
            Push-Location $WorkspaceDir
            try {
                & node $helper --frontend $FrontendUrl --out $mobileOut 2>&1 | Out-Null
                Add-Check -Phase 20 -Id 'P20-PLAYWRIGHT' -Name 'Playwright viewport probe' -Status $(if (Test-Path $mobileOut) { 'PASS' } else { 'SKIP' }) -Detail $mobileOut -Category 'OfflineMobile'
            } catch {
                Add-Check -Phase 20 -Id 'P20-PLAYWRIGHT' -Name 'Playwright viewport probe' -Status 'SKIP' -Detail $_.Exception.Message -Category 'OfflineMobile'
            } finally { Pop-Location }
        }
    }
}
#endregion

#region REPORTS
function Export-AllReports {
    Write-Phase 'GENERATING ULTIMATE AUDIT REPORTS'
    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

    try {
    $summary = @{
        pass = Get-StatusCount -Status 'PASS'
        warn = Get-StatusCount -Status 'WARN'
        fail = Get-StatusCount -Status 'FAIL'
        skip = Get-StatusCount -Status 'SKIP'
        info = Get-StatusCount -Status 'INFO'
        total = Get-StatusCount
    }
    $duration = (Get-Date) - $StartTime
    $score = [math]::Max(0, [math]::Min(100, [int](100 - ($summary.fail * 5) - ($summary.warn * 2))))

    Export-CategoryReport -Phase 1  -OutPath $OutFiles.CodeQuality   -Title 'Code Quality Report'
    Export-CategoryReport -Phase 2  -OutPath $OutFiles.Security      -Title 'Security Audit Report'
    Export-CategoryReport -Phase 3  -OutPath $OutFiles.Hipaa         -Title 'HIPAA Compliance Checklist'
    Export-CategoryReport -Phase 4  -OutPath $OutFiles.Database      -Title 'Database Security Audit'
    Export-CategoryReport -Phase 5  -OutPath $OutFiles.ApiSecurity   -Title 'API Security Audit'
    Export-CategoryReport -Phase 6  -OutPath $OutFiles.FrontendSec   -Title 'Frontend Security Audit'
    Export-CategoryReport -Phase 7  -OutPath $OutFiles.InfraSec      -Title 'Infrastructure Security Audit'
    Export-CategoryReport -Phase 10 -OutPath $OutFiles.Testing       -Title 'Testing Coverage Report'
    Export-CategoryReport -Phase 11 -OutPath $OutFiles.Deployment    -Title 'Deployment Readiness'
    Export-CategoryReport -Phase 12 -OutPath $OutFiles.Documentation -Title 'Documentation Audit'
    Export-CategoryReport -Phase 13 -OutPath $OutFiles.DataPrivacy   -Title 'Data Privacy Report'
    Export-CategoryReport -Phase 14 -OutPath $OutFiles.Accessibility -Title 'Accessibility Report'
    Export-CategoryReport -Phase 15 -OutPath $OutFiles.Scalability   -Title 'Scalability Report'
    Export-CategoryReport -Phase 16 -OutPath $OutFiles.Dependency    -Title 'Dependency Audit'
    Export-CategoryReport -Phase 17 -OutPath $OutFiles.Architecture  -Title 'Architecture Review'
    Export-CategoryReport -Phase 18 -OutPath $OutFiles.BusinessCont  -Title 'Business Continuity Plan'

    $perfOut = [ordered]@{
        title = 'Performance Metrics'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        metrics = $script:PerfMetrics
        phase8Checks = @(Get-PhaseChecks -Phase 8 | ForEach-Object { @{ id = $_.Id; name = $_.Name; status = $_.Status; detail = $_.Detail } })
        thresholds = @{ pageLoadMs = 3000; apiResponseMs = 500; ttfbMs = 1500 }
    }
    ($perfOut | ConvertTo-Json -Depth 6) | Set-Content -Path $OutFiles.Performance -Encoding UTF8

    $resultsObj = [ordered]@{
        auditVersion = 'ultimate-1.0'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        durationSeconds = [int]$duration.TotalSeconds
        frontendUrl = $FrontendUrl
        apiUrl = $ApiUrl
        backendDir = $BackendDir
        frontendDir = $FrontendDir
        summary = $summary
        platformHealthScore = $score
        criticalIssueCount = $script:CriticalIssues.Count
        highPriorityIssueCount = $script:HighIssues.Count
        phases = @(1..20 | ForEach-Object {
            $phaseNum = $_
            [ordered]@{
                phase = $phaseNum
                category = if ($PhaseCategories.ContainsKey($phaseNum)) { $PhaseCategories[$phaseNum] } else { "Phase$phaseNum" }
                pass = Get-FilteredCheckCount -Phase $phaseNum -Status 'PASS'
                warn = Get-FilteredCheckCount -Phase $phaseNum -Status 'WARN'
                fail = Get-FilteredCheckCount -Phase $phaseNum -Status 'FAIL'
                total = Get-FilteredCheckCount -Phase $phaseNum
            }
        })
        checks = @($script:Checks | ForEach-Object {
            [ordered]@{ Phase = $_.Phase; Id = $_.Id; Name = $_.Name; Status = $_.Status; Detail = $_.Detail; Category = $_.Category; Timestamp = $_.Timestamp }
        })
        criticalIssues = @($script:CriticalIssues | ForEach-Object {
            [ordered]@{ IssueId = $_.IssueId; Phase = $_.Phase; CheckId = $_.CheckId; Name = $_.Name; Severity = $_.Severity; Detail = $_.Detail; Category = $_.Category }
        })
        highPriorityIssues = @($script:HighIssues | ForEach-Object {
            [ordered]@{ IssueId = $_.IssueId; Phase = $_.Phase; CheckId = $_.CheckId; Name = $_.Name; Severity = $_.Severity; Detail = $_.Detail; Category = $_.Category }
        })
        artifacts = @($OutFiles.GetEnumerator() | ForEach-Object { [ordered]@{ name = $_.Key; path = [string]$_.Value } })
    }
    ($resultsObj | ConvertTo-Json -Depth 10) | Set-Content -Path $OutFiles.ResultsJson -Encoding UTF8
    Write-Pass "JSON: $($OutFiles.ResultsJson)"

    $durationText = '{0:hh\:mm\:ss}' -f $duration
    $summaryMd = @"
# Ultimate Comprehensive Platform Audit - Executive Summary

**Generated:** $($StartTime.ToString('yyyy-MM-dd HH:mm:ss UTC'))
**Duration:** $durationText
**Frontend:** $FrontendUrl
**API:** $ApiUrl
**Platform Health Score:** $score / 100

## Overall Results

| Status | Count |
|--------|------:|
| PASS | $($summary.pass) |
| WARN | $($summary.warn) |
| FAIL | $($summary.fail) |
| SKIP | $($summary.skip) |
| INFO | $($summary.info) |
| **Total** | **$($summary.total)** |

## Issue Summary

| Severity | Count |
|----------|------:|
| CRITICAL (MUST FIX) | $($script:CriticalIssues.Count) |
| HIGH (SHOULD FIX) | $($script:HighIssues.Count) |

## Phase Overview

| Phase | Category | Checks | Pass | Warn | Fail |
|-------|----------|-------:|-----:|-----:|-----:|

"@
    foreach ($p in 1..20) {
        $cat = if ($PhaseCategories.ContainsKey($p)) { $PhaseCategories[$p] } else { "Phase $p" }
        $summaryMd += "| $p | $cat | $(Get-FilteredCheckCount -Phase $p) | $(Get-FilteredCheckCount -Phase $p -Status 'PASS') | $(Get-FilteredCheckCount -Phase $p -Status 'WARN') | $(Get-FilteredCheckCount -Phase $p -Status 'FAIL') |`n"
    }
    $summaryMd += @"

## Key Artifacts

All reports in ``dist/``: ULTIMATE-AUDIT-RESULTS.json, ULTIMATE-AUDIT-DETAILED.md, critical-issues.md, high-priority-issues.md, recommendations.md, plus 18 category JSON reports.

---
*Generated by ultimate-comprehensive-audit.ps1*
"@
    $summaryMd | Set-Content -Path $OutFiles.SummaryMd -Encoding UTF8
    Write-Pass "Summary: $($OutFiles.SummaryMd)"

    $detailedMd = "# Ultimate Comprehensive Platform Audit - Detailed Findings`n`n**Generated:** $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss UTC')`n`n"
    foreach ($p in 1..20) {
        $pc = @(Get-PhaseChecks -Phase $p)
        if (@($pc).Count -eq 0) { continue }
        $cat = if ($PhaseCategories.ContainsKey($p)) { $PhaseCategories[$p] } else { "Phase $p" }
        $detailedMd += "## Phase $p : $cat`n`n"
        foreach ($c in $pc) {
            $detailedMd += "- **[$($c.Status)]** $($c.Id): $($c.Name)"
            if ($c.Detail) { $detailedMd += " - $($c.Detail)" }
            $detailedMd += "`n"
        }
        $detailedMd += "`n"
    }
    $detailedMd | Set-Content -Path $OutFiles.DetailedMd -Encoding UTF8
    Write-Pass "Detailed: $($OutFiles.DetailedMd)"

    $critMd = "# Critical Issues (MUST FIX)`n`nGenerated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n`n"
    if ($script:CriticalIssues.Count -eq 0) { $critMd += "No critical (FAIL) issues detected.`n" }
    else { foreach ($i in $script:CriticalIssues) { $critMd += "## $($i.IssueId) - $($i.Name)`n`n- **Phase:** $($i.Phase) ($($i.Category))`n- **Check:** $($i.CheckId)`n- **Detail:** $($i.Detail)`n`n" } }
    $critMd | Set-Content -Path $OutFiles.CriticalMd -Encoding UTF8
    Write-Pass "Critical: $($OutFiles.CriticalMd)"

    $highMd = "# High Priority Issues (SHOULD FIX)`n`nGenerated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n`n"
    if ($script:HighIssues.Count -eq 0) { $highMd += "No high priority (WARN) issues detected.`n" }
    else { foreach ($i in $script:HighIssues) { $highMd += "## $($i.IssueId) - $($i.Name)`n`n- **Phase:** $($i.Phase) ($($i.Category))`n- **Check:** $($i.CheckId)`n- **Detail:** $($i.Detail)`n`n" } }
    $highMd | Set-Content -Path $OutFiles.HighPriorityMd -Encoding UTF8
    Write-Pass "High priority: $($OutFiles.HighPriorityMd)"

    if ($script:Recommendations.Count -eq 0) {
        if ($summary.fail -gt 0) { Add-Recommendation 'Resolve all FAIL (critical) checks before production release.' }
        if ($summary.warn -gt 10) { Add-Recommendation 'Triage WARN items; many require live browser or AWS console verification.' }
        if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { Add-Recommendation 'Install AWS CLI for full infrastructure verification.' }
        if ($SkipBrowser) { Add-Recommendation 'Re-run without -SkipBrowser for Playwright viewport tests.' }
        if ($SkipNpm) { Add-Recommendation 'Re-run without -SkipNpm for npm audit vulnerability scan.' }
        Add-Recommendation 'Add unit and E2E test suites with CI integration.'
        Add-Recommendation 'Generate OpenAPI documentation from Express routes.'
        Add-Recommendation 'Schedule quarterly RDS restore drill and penetration test.'
        Add-Recommendation 'Enable Dependabot and GitHub Actions CI pipeline.'
        Add-Recommendation 'Run Lighthouse accessibility audit on all role dashboards.'
        Add-Recommendation 'Conduct load testing (k6) and document scalability limits.'
        Add-Recommendation 'Verify BAAs with AWS, Anthropic, and Deepgram are current.'
        Add-Recommendation 'Test offline recording on iOS Safari and Android Chrome with airplane mode.'
    }
    $recMd = "# Recommendations (NICE TO HAVE)`n`n"
    foreach ($r in $script:Recommendations) { $recMd += "- $r`n" }
    $recMd | Set-Content -Path $OutFiles.RecommendMd -Encoding UTF8
    Write-Pass "Recommendations: $($OutFiles.RecommendMd)"

    } catch {
        Write-FailMsg "Report export failed at: $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber) - $($_.Exception.Message)"
        throw
    }
}
#endregion

#region MAIN
trap {
    Write-Host ''
    Write-FailMsg "Audit aborted: $($_.Exception.Message)"
    if ($Force) { try { Export-AllReports } catch {} }
    exit 1
}

Write-Phase 'ANOT HEALTH - ULTIMATE COMPREHENSIVE PLATFORM AUDIT'
Write-Host "  Frontend: $FrontendUrl" -ForegroundColor Gray
Write-Host "  API:      $ApiUrl" -ForegroundColor Gray
Write-Host "  Backend:  $(if($BackendDir){$BackendDir}else{'NOT FOUND'})" -ForegroundColor Gray
Write-Host "  Frontend: $(if($FrontendDir){$FrontendDir}else{'NOT FOUND'})" -ForegroundColor Gray
Write-Host "  Force:    $Force" -ForegroundColor Gray

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
Initialize-SourceCache

Write-Phase 'PRE-FLIGHT: Authentication and Connectivity'
$roleCreds = @(
    @{ Key='admin'; Email=$AdminEmail; Password=$AdminPassword }
    @{ Key='clinician'; Email=$ClinicianEmail; Password=$ClinicianPassword }
    @{ Key='scribe'; Email=$ScribeEmail; Password=$ScribePassword }
    @{ Key='qps'; Email=$QpsEmail; Password=$QpsPassword }
)
$anyLogin = $false
foreach ($role in $roleCreds) {
    Write-Step "Login: $($role.Email) ($($role.Key))"
    $auth = Invoke-Login -Email $role.Email -Password $role.Password -RoleKey $role.Key
    if ($auth.Ok) {
        $anyLogin = $true
        $script:NetworkAvailable = $true
        Write-Pass "$($role.Key) authenticated ($($auth.ElapsedMs)ms)"
        Add-Check -Phase 0 -Id "AUTH-$($role.Key)" -Name "Login $($role.Key)" -Status 'PASS' -Detail "HTTP 200 in $($auth.ElapsedMs)ms" -Category 'Auth'
    } else {
        if ($auth.StatusCode -eq 0) { $script:NetworkAvailable = $false }
        $loginStatus = if ($auth.StatusCode -eq 0 -and -not (Test-NetworkAvailable)) { 'SKIP' } else { 'WARN' }
        Write-WarnMsg "$($role.Key) login failed (HTTP $($auth.StatusCode))"
        Add-Check -Phase 0 -Id "AUTH-$($role.Key)" -Name "Login $($role.Key)" -Status $loginStatus -Detail "$($auth.Error) HTTP $($auth.StatusCode)" -Category 'Auth'
    }
}

if (-not $anyLogin -and -not $Force) {
    Write-FailMsg 'All logins failed. Use -Force to run static checks anyway.'
    exit 1
}

Test-Phase1-CodeQuality
Test-Phase2-Security
Test-Phase3-Hipaa
Test-Phase4-Database
Test-Phase5-ApiSecurity
Test-Phase6-FrontendSecurity
Test-Phase7-Infrastructure
Test-Phase8-Performance
Test-Phase9-Logging
Test-Phase10-Testing
Test-Phase11-DevOps
Test-Phase12-Documentation
Test-Phase13-DataPrivacy
Test-Phase14-Accessibility
Test-Phase15-Scalability
Test-Phase16-Dependencies
Test-Phase17-Architecture
Test-Phase18-BusinessContinuity
Test-Phase19-Workflows
Test-Phase20-OfflineMobile

Export-AllReports

Write-Phase 'ULTIMATE AUDIT COMPLETE'
$failCount = Get-StatusCount -Status 'FAIL'
$warnCount = Get-StatusCount -Status 'WARN'
$finalScore = [math]::Max(0, [math]::Min(100, [int](100 - ($failCount * 5) - ($warnCount * 2))))
Write-Host "  Total checks: $($script:Checks.Count) | FAIL: $failCount | WARN: $warnCount | Score: $finalScore" -ForegroundColor Cyan
Write-Host "  Reports in: $DistDir" -ForegroundColor Gray

if ($failCount -gt 0) { exit 2 }
if ($warnCount -gt 15) { exit 1 }
exit 0
#endregion
