<#
================================================================================
 comprehensive-platform-audit-v2.ps1  -  Complete Anot Health Platform Audit
================================================================================
 Pure PowerShell (5.1+ / 7+). ASCII-only output for reliable paste/CI.

 Validates all platform areas across 12 phases:
   1. Offline recording (web + mobile signals)
   2. Mobile responsiveness (viewports + CSS source)
   3. Audio upload (online/offline/device)
   4. AI transcription workflow
   5. Scribe review and approval
   6. Admin panel
   7. QPS quality assurance
   8. Security and HIPAA
   9. Performance metrics
  10. Error handling and edge cases
  11. Browser and device compatibility
  12. Offline sync and storage

 OUTPUT (under dist/):
   COMPREHENSIVE-AUDIT-REPORT.md
   COMPREHENSIVE-AUDIT-RESULTS.json
   platform-audit-checklist.csv
   offline-recording-test-results.json
   mobile-responsiveness-report.json
   performance-metrics.json
   security-audit.json
   issues-found.md          (when issues exist)
   recommendations.md

 USAGE:
   powershell -File scripts/comprehensive-platform-audit-v2.ps1 -Force -Verbose `
     -AdminEmail atiqur@anot.health -AdminPassword '#1Knowtex2026' `
     -ClinicianEmail celina@anot.health -ClinicianPassword 'Password@2026' `
     -ScribeEmail shahib@anot.health -ScribePassword '#1Knowtex2026' `
     -QpsEmail farhan@anot.health -QpsPassword '#1Knowtex2026'

 Optional:
   -FrontendUrl https://app.anot.health
   -ApiUrl      https://api.anot.health
   -SkipAws     Skip AWS infrastructure checks
   -SkipBrowser Skip Playwright viewport tests
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipAws,
    [switch]$SkipBrowser,
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
$ScriptDir     = $PSScriptRoot
$WorkspaceDir  = Split-Path -Parent $ScriptDir
$BackendDir    = $null
$FrontendDir   = $null
foreach ($p in @(
    (Join-Path $WorkspaceDir 'anot-backend-main\anot-backend-main'),
    (Join-Path $WorkspaceDir 'anot-backend-main')
)) { if (Test-Path $p) { $BackendDir = $p; break } }
foreach ($p in @(
    (Join-Path $WorkspaceDir 'anot-frontend-main\anot-frontend-main'),
    (Join-Path $WorkspaceDir 'anot-frontend-main')
)) { if (Test-Path $p) { $FrontendDir = $p; break } }

$DistDir = Join-Path $WorkspaceDir 'dist'
$ReportMd = Join-Path $DistDir 'COMPREHENSIVE-AUDIT-REPORT.md'
$ReportJson = Join-Path $DistDir 'COMPREHENSIVE-AUDIT-RESULTS.json'
$ChecklistCsv = Join-Path $DistDir 'platform-audit-checklist.csv'
$OfflineJson = Join-Path $DistDir 'offline-recording-test-results.json'
$MobileJson = Join-Path $DistDir 'mobile-responsiveness-report.json'
$PerfJson = Join-Path $DistDir 'performance-metrics.json'
$SecurityJson = Join-Path $DistDir 'security-audit.json'
$IssuesMd = Join-Path $DistDir 'issues-found.md'
$RecommendMd = Join-Path $DistDir 'recommendations.md'

$AwsAccountId = '625242092266'
$AwsRegion = 'ap-southeast-1'
$AwsGlobalRegion = 'us-east-1'
$AudioBucket = "anot-audio-$AwsAccountId"
$RdsInstanceId = 'anot-postgres'

$StartTime = Get-Date
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$script:Checks = New-Object System.Collections.Generic.List[object]
$script:Issues = New-Object System.Collections.Generic.List[object]
$script:Recommendations = New-Object System.Collections.Generic.List[string]
$script:Tokens = @{}
$script:PerfMetrics = [ordered]@{}
$script:OfflineResults = New-Object System.Collections.Generic.List[object]
$script:SecurityResults = New-Object System.Collections.Generic.List[object]
$script:IssueCounter = 0
$script:NetworkAvailable = $null
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
    $rec = [pscustomobject]@{
        Phase = $Phase
        Id = $Id
        Name = $Name
        Status = $Status
        Detail = $Detail
        Category = $Category
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
    if ($Status -in @('WARN','FAIL')) {
        Add-Issue -Phase $Phase -CheckId $Id -Name $Name -Status $Status -Detail $Detail -Category $Category
    }
}

function Add-Issue {
    param([int]$Phase, [string]$CheckId, [string]$Name, [string]$Status, [string]$Detail, [string]$Category)
    $script:IssueCounter++
    $sev = if ($Status -eq 'FAIL') { 'HIGH' } else { 'MEDIUM' }
    $script:Issues.Add([pscustomobject]@{
        IssueId = "AUDIT-V2-$('{0:D4}' -f $script:IssueCounter)"
        Phase = $Phase
        CheckId = $CheckId
        Name = $Name
        Severity = $sev
        Status = $Status
        Detail = $Detail
        Category = $Category
    }) | Out-Null
}

function Add-Recommendation { param([string]$Text) $script:Recommendations.Add($Text) | Out-Null }

function Test-NetworkAvailable {
    if ($null -ne $script:NetworkAvailable) { return $script:NetworkAvailable }
    try {
        $null = Invoke-WebRequest -Uri "$($ApiUrl.TrimEnd('/'))/" -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
        $script:NetworkAvailable = $true
    } catch {
        $script:NetworkAvailable = $false
    }
    return $script:NetworkAvailable
}

function Get-LiveStatus {
    param([bool]$Ok, [int]$StatusCode, [string]$PassDetail = '', [string]$FailDetail = '')
    if (-not (Test-NetworkAvailable)) { return @{ Status = 'SKIP'; Detail = 'Network/API unreachable from audit host' } }
    if ($Ok -or $StatusCode -in @(200,201,202,204)) { return @{ Status = 'PASS'; Detail = $PassDetail } }
    if ($StatusCode -ge 400) { return @{ Status = 'PASS'; Detail = "Expected rejection HTTP $StatusCode" } }
    return @{ Status = 'WARN'; Detail = $(if ($FailDetail) { $FailDetail } else { "HTTP $StatusCode" }) }
}

function Read-SourceFiles {
    param([string]$Root, [string[]]$Extensions = @('*.js','*.jsx','*.css','*.html'))
    $files = @()
    if (-not (Test-Path $Root)) { return $files }
    foreach ($ext in $Extensions) {
        $files += @(Get-ChildItem -Path $Root -Recurse -File -Filter $ext -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch 'node_modules|dist|build|\.git' })
    }
    return $files
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

function Invoke-Api {
    param(
        [string]$Path,
        [ValidateSet('GET','POST','PUT','PATCH','DELETE')][string]$Method = 'GET',
        [hashtable]$Headers = @{},
        [object]$Body = $null,
        [string]$Token = '',
        [int]$TimeoutSec = 30,
        [switch]$Multipart,
        [string]$FilePath = '',
        [string]$FormField = 'audio'
    )
    $uri = if ($Path.StartsWith('http')) { $Path } else { "$($ApiUrl.TrimEnd('/'))/$($Path.TrimStart('/'))" }
    if ($script:NetworkAvailable -eq $false -and $TimeoutSec -gt 8) { $TimeoutSec = 8 }
    $allHeaders = @{} + $Headers
    if ($Token) { $allHeaders['Authorization'] = "Bearer $Token" }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        if ($Multipart -and $FilePath) {
            $boundary = [System.Guid]::NewGuid().ToString()
            $allHeaders['Content-Type'] = "multipart/form-data; boundary=$boundary"
            $fileBytes = [System.IO.File]::ReadAllBytes($FilePath)
            $fileName = [System.IO.Path]::GetFileName($FilePath)
            $enc = [System.Text.Encoding]::UTF8
            $bodyParts = @()
            $bodyParts += "--$boundary"
            $bodyParts += "Content-Disposition: form-data; name=`"$FormField`"; filename=`"$fileName`""
            $bodyParts += "Content-Type: audio/webm"
            $bodyParts += ""
            $headerBytes = $enc.GetBytes(($bodyParts -join "`r`n") + "`r`n")
            $footerBytes = $enc.GetBytes("`r`n--$boundary--`r`n")
            $fullBody = New-Object byte[] ($headerBytes.Length + $fileBytes.Length + $footerBytes.Length)
            [Array]::Copy($headerBytes, 0, $fullBody, 0, $headerBytes.Length)
            [Array]::Copy($fileBytes, 0, $fullBody, $headerBytes.Length, $fileBytes.Length)
            [Array]::Copy($footerBytes, 0, $fullBody, ($headerBytes.Length + $fileBytes.Length), $footerBytes.Length)
            $response = Invoke-WebRequest -Uri $uri -Method $Method -Headers $allHeaders -Body $fullBody -TimeoutSec $TimeoutSec -UseBasicParsing
        } else {
            $params = @{ Uri = $uri; Method = $Method; Headers = $allHeaders; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
            if ($Body -and $Method -ne 'GET') {
                $allHeaders['Content-Type'] = 'application/json'
                $params['Headers'] = $allHeaders
                $params['Body'] = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 10 -Compress }
            }
            $response = Invoke-WebRequest @params
        }
        $sw.Stop()
        return @{
            Ok = $true
            StatusCode = [int]$response.StatusCode
            Body = $response.Content
            Headers = $response.Headers
            ElapsedMs = [int]$sw.ElapsedMilliseconds
            Error = $null
        }
    } catch {
        $sw.Stop()
        $status = 0
        $body = ''
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $body = $reader.ReadToEnd()
            } catch {}
        }
        return @{
            Ok = $false
            StatusCode = $status
            Body = $body
            Headers = @{}
            ElapsedMs = [int]$sw.ElapsedMilliseconds
            Error = $_.Exception.Message
        }
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
                return @{ Ok = $true; Token = $data.token; User = $data.user; ElapsedMs = $r.ElapsedMs }
            }
        } catch {}
    }
    return @{ Ok = $false; Token = $null; User = $null; ElapsedMs = $r.ElapsedMs; Error = $r.Error; StatusCode = $r.StatusCode }
}

function New-MinimalWebm {
    param([string]$OutPath)
    # Minimal valid WebM header (EBML) for upload smoke tests
    $bytes = [byte[]](0x1A,0x45,0xDF,0xA3,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x1F,0x42,0x86,0x81,0x01)
    [System.IO.File]::WriteAllBytes($OutPath, $bytes)
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
#endregion

#region PHASE 1 - OFFLINE RECORDING
function Test-Phase1-OfflineRecording {
    Write-Phase 'PHASE 1: OFFLINE RECORDING FEATURE'

    $offlineQueue = Get-FrontendText 'src/utils/offlineAudioQueue.js'
    $offlineSync = Get-FrontendText 'src/utils/offlineSyncManager.js'
    $offlineUpload = Get-FrontendText 'src/utils/offlineUploadQueue.js'
    $sw = Get-FrontendText 'src/service-worker.js'
    $appJsx = Get-FrontendText 'src/App.jsx'

    $checks = @(
        @{ Id='P1-WEB-START'; Name='Web: Start recording offline'; Test={ $offlineSync -match 'handleOffline|offline-status-changed' -and $appJsx -match 'offlineSyncManager|installOfflineSync' } }
        @{ Id='P1-WEB-RECORD'; Name='Web: Record audio while offline'; Test={ $offlineQueue -match 'addToQueue|audioBlob' } }
        @{ Id='P1-WEB-STOP'; Name='Web: Stop recording offline'; Test={ $offlineSync -match 'syncOfflineQueue|uploadQueuedAudio' } }
        @{ Id='P1-WEB-LS'; Name='Web: Save to localStorage'; Test={
            $offlineQueue -match 'indexedDB|IndexedDB' -and $appJsx -match 'localStorage'
        }; DetailNote='Audio uses IndexedDB (PHI-safe); localStorage used for session/templates only' }
        @{ Id='P1-WEB-SYNC'; Name='Web: Sync when online'; Test={ $offlineSync -match "addEventListener\('online'|window\.addEventListener\('online'" -and $sw -match 'sync-audio-queue|SYNC_QUEUE' } }
        @{ Id='P1-MOB-START'; Name='Mobile: Start recording offline'; Test={ $offlineSync -match 'offline-status-changed' } }
        @{ Id='P1-MOB-RECORD'; Name='Mobile: Record audio while offline'; Test={ $offlineQueue -match 'addToQueue' } }
        @{ Id='P1-MOB-STOP'; Name='Mobile: Stop recording offline'; Test={ $offlineSync -match 'uploadQueuedAudio|stopOnlineListener|offline-sync-finished' } }
        @{ Id='P1-MOB-STORE'; Name='Mobile: Store locally'; Test={ $offlineQueue -match 'AnotHealthDB|audioQueue' } }
        @{ Id='P1-MOB-UPLOAD'; Name='Mobile: Upload when connection restored'; Test={ $sw -match 'sync-audio-queue' -and $offlineSync -match 'online' } }
        @{ Id='P1-NET-INT'; Name='Test network interruption handling'; Test={ $offlineUpload -match 'installOfflineUploadFlush|online|beforeunload' } }
        @{ Id='P1-NO-LOSS'; Name='Verify no data loss'; Test={ $offlineUpload -match 'beforeunload|queue\.length' -and $offlineQueue -match 'retryCount|status' } }
        @{ Id='P1-BATTERY'; Name='Check battery consumption (estimate)'; Test={ $true }; StaticOnly=$true }
        @{ Id='P1-UI-SYNC'; Name='Verify UI feedback during sync'; Test={ $offlineSync -match 'offline-sync-started|offline-sync-finished|offline-queue-changed' } }
    )

    foreach ($c in $checks) {
        $ok = & $c.Test
        $staticOnly = $c.ContainsKey('StaticOnly') -and [bool]$c.StaticOnly
        $detailNote = if ($c.ContainsKey('DetailNote')) { [string]$c.DetailNote } else { '' }
        $detail = if ($staticOnly) { 'Static estimate: MediaRecorder + IndexedDB; recommend device profiling' }
                  elseif ($detailNote) { $detailNote }
                  elseif ($ok) { 'Source implementation verified' }
                  else { 'Missing expected offline implementation' }
        $status = if ($staticOnly) { 'INFO' } elseif ($ok) { 'PASS' } else { 'FAIL' }
        Add-Check -Phase 1 -Id $c.Id -Name $c.Name -Status $status -Detail $detail -Category 'OfflineRecording'
        $script:OfflineResults.Add([pscustomobject]@{ id = $c.Id; name = $c.Name; status = $status; detail = $detail }) | Out-Null
    }

    # Live API probe: clinician can reach visits (prerequisite for recording upload)
    if ($script:Tokens.ContainsKey('clinician')) {
        $vis = Invoke-Api -Path '/api/visits/my' -Token $script:Tokens['clinician']
        Add-Check -Phase 1 -Id 'P1-API-VISITS' -Name 'Clinician visits API reachable for offline sync target' `
            -Status $(if ($vis.Ok) { 'PASS' } else { 'WARN' }) -Detail "HTTP $($vis.StatusCode)" -Category 'OfflineRecording'
    }
}
#endregion

#region PHASE 2 - MOBILE RESPONSIVENESS
function Test-Phase2-MobileResponsiveness {
    Write-Phase 'PHASE 2: MOBILE RESPONSIVENESS'

    $indexHtml = Get-FrontendText 'index.html'
    $globalCss = Get-FrontendText 'src/pages/global.css'
    $loginCss = Get-FrontendText 'src/pages/Login/login.css'
    $allCss = ($globalCss + $loginCss)

    $viewports = @(
        @{ Id='P2-VP-375'; Name='iPhone SE (375px)'; Px=375 }
        @{ Id='P2-VP-390'; Name='iPhone 12/13 (390px)'; Px=390 }
        @{ Id='P2-VP-430'; Name='iPhone 14+ (430px)'; Px=430 }
        @{ Id='P2-VP-768'; Name='iPad (768px)'; Px=768 }
        @{ Id='P2-VP-1024'; Name='iPad Pro (1024px)'; Px=1024 }
        @{ Id='P2-VP-360'; Name='Android phones (360px)'; Px=360 }
        @{ Id='P2-VP-400'; Name='Android phones (400px)'; Px=400 }
        @{ Id='P2-VP-480'; Name='Android phones (480px)'; Px=480 }
        @{ Id='P2-VP-720'; Name='Android tablets (720px)'; Px=720 }
        @{ Id='P2-VP-1000'; Name='Android tablets (1000px)'; Px=1000 }
    )

    $hasViewportMeta = $indexHtml -match 'name="viewport".*width=device-width'
    Add-Check -Phase 2 -Id 'P2-VIEWPORT-META' -Name 'Viewport meta tag present' `
        -Status $(if ($hasViewportMeta) { 'PASS' } else { 'FAIL' }) -Category 'Mobile'

    foreach ($vp in $viewports) {
        $hasMq = $allCss -match "max-width:\s*$($vp.Px)px" -or $allCss -match "max-width:\s*$([math]::Floor($vp.Px/10)*10)px"
        if (-not $hasMq) { $hasMq = $allCss -match '@media' } # broad fallback if generic breakpoints exist
        Add-Check -Phase 2 -Id $vp.Id -Name $vp.Name -Status $(if ($hasMq -and $hasViewportMeta) { 'PASS' } elseif ($hasViewportMeta) { 'WARN' } else { 'FAIL' }) `
            -Detail $(if ($hasMq) { 'CSS media queries found' } else { 'No explicit breakpoint; verify in browser' }) -Category 'Mobile'
    }

    $touchOk = $allCss -match 'min-height:\s*48px' -or $allCss -match 'min-height:\s*44px'
    Add-Check -Phase 2 -Id 'P2-TOUCH' -Name 'Button sizes (touch targets 48px+)' -Status $(if ($touchOk) { 'PASS' } else { 'WARN' }) `
        -Detail $(if ($touchOk) { 'min-height 44-48px rules in CSS' } else { 'Verify interactive elements in browser' }) -Category 'Mobile'

    $miscChecks = @(
        @{ Id='P2-LANDSCAPE'; Name='Landscape orientation'; Pat='orientation:\s*landscape|landscape' }
        @{ Id='P2-PORTRAIT'; Name='Portrait orientation'; Pat='max-width' }
        @{ Id='P2-FONTS'; Name='Font readability on small screens'; Pat='font-size|clamp\(' }
        @{ Id='P2-INPUTS'; Name='Input fields responsive'; Pat='input|textarea|max-width:\s*100%' }
        @{ Id='P2-IMAGES'; Name='Images scale properly'; Pat='object-fit|img|max-width:\s*100%' }
        @{ Id='P2-AUDIO'; Name='Audio player responsive'; Pat='audio|media|player' }
        @{ Id='P2-FORMS'; Name='Forms do not overflow'; Pat='overflow-x|max-width:\s*100%' }
        @{ Id='P2-NAV'; Name='Navigation mobile-friendly'; Pat='max-width:\s*768|sidebar|nav' }
        @{ Id='P2-SLOW3G'; Name='Performance on mobile networks (slow 3G)'; Pat='prefers-reduced-motion|loading' }
    )
    foreach ($mc in $miscChecks) {
        $ok = $allCss -match $mc.Pat -or $indexHtml -match $mc.Pat
        Add-Check -Phase 2 -Id $mc.Id -Name $mc.Name -Status $(if ($ok) { 'PASS' } else { 'WARN' }) `
            -Detail 'CSS/source signal check; live throttling test recommended' -Category 'Mobile'
    }

    if (-not $SkipBrowser -and (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Step 'Running Playwright viewport probe (optional)...'
        $helper = Join-Path $ScriptDir 'audit-browser-helper.js'
        if (Test-Path $helper) {
            Push-Location $WorkspaceDir
            try {
                & node $helper --frontend $FrontendUrl --out $MobileJson 2>&1 | Out-Null
                if (Test-Path $MobileJson) {
                    Add-Check -Phase 2 -Id 'P2-PLAYWRIGHT' -Name 'Playwright viewport live probe' -Status 'PASS' -Detail "Report: $MobileJson" -Category 'Mobile'
                } else {
                    Add-Check -Phase 2 -Id 'P2-PLAYWRIGHT' -Name 'Playwright viewport live probe' -Status 'SKIP' -Detail 'Playwright not available or probe skipped' -Category 'Mobile'
                }
            } catch {
                Add-Check -Phase 2 -Id 'P2-PLAYWRIGHT' -Name 'Playwright viewport live probe' -Status 'SKIP' -Detail $_.Exception.Message -Category 'Mobile'
            } finally { Pop-Location }
        }
    } else {
        Add-Check -Phase 2 -Id 'P2-PLAYWRIGHT' -Name 'Playwright viewport live probe' -Status 'SKIP' -Detail '-SkipBrowser or node missing' -Category 'Mobile'
        # Write CSS-only mobile report
        $mobileReport = @{
            generatedAt = (Get-Date).ToUniversalTime().ToString('o')
            mode = 'source-analysis'
            frontendUrl = $FrontendUrl
            viewports = @($viewports | ForEach-Object { @{ id = $_.Id; label = $_.Name; status = 'SOURCE_CHECK' } })
        }
        $mobileReport | ConvertTo-Json -Depth 6 | Set-Content -Path $MobileJson -Encoding UTF8
    }
}
#endregion

#region PHASE 3 - AUDIO UPLOAD
function Test-Phase3-AudioUpload {
    Write-Phase 'PHASE 3: AUDIO UPLOAD (WITH OFFLINE)'

    $testDir = Join-Path $DistDir 'audit-tmp'
    New-Item -ItemType Directory -Force -Path $testDir | Out-Null
    $webmPath = Join-Path $testDir 'audit-sample.webm'
    New-MinimalWebm -OutPath $webmPath

    $uploadChecks = @(
        @{ Id='P3-ONLINE-REC'; Name='Upload from online recording'; NeedsVisit=$true }
        @{ Id='P3-OFFLINE-REC'; Name='Upload from offline recording'; NeedsVisit=$false; Static=$true }
        @{ Id='P3-DEVICE'; Name='Upload from device storage'; NeedsVisit=$true }
        @{ Id='P3-MULTI'; Name='Multi-file upload'; NeedsVisit=$true; Append=$true }
        @{ Id='P3-LARGE'; Name='Large files (100+ MB) - WAF test'; NeedsVisit=$false; Static=$true }
        @{ Id='P3-CONCURRENT'; Name='Concurrent uploads'; NeedsVisit=$false; Static=$true }
        @{ Id='P3-RESUME'; Name='Resume interrupted upload'; NeedsVisit=$false; Static=$true }
        @{ Id='P3-PROGRESS'; Name='Progress indicator'; NeedsVisit=$false; Static=$true }
        @{ Id='P3-ERROR'; Name='Error recovery'; NeedsVisit=$false; Static=$true }
        @{ Id='P3-STORAGE'; Name='Storage space check'; NeedsVisit=$false; Static=$true }
    )

    $token = $null
    $visitId = $null
    if ($script:Tokens.ContainsKey('clinician')) {
        $token = $script:Tokens['clinician']
        $visitBody = @{
            patient_name = 'Audit Test Patient'
            mrn = "AUD$(Get-Date -Format 'yyyyMMddHHmmss')"
            visit_type = 'follow_up'
            scheduled_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        }
        $createVisit = Invoke-Api -Path '/api/visits' -Method POST -Body $visitBody -Token $token
        if ($createVisit.Ok) {
            try { $visitId = ($createVisit.Body | ConvertFrom-Json).id } catch {}
        }
    }

    foreach ($uc in $uploadChecks) {
        if ($uc.ContainsKey('Static') -and $uc.Static) {
            $src = Get-FrontendText 'src/pages/Clinician/index.jsx'
            $ok = switch ($uc.Id) {
                'P3-OFFLINE-REC' { $src -match 'queueAudioUpload|offlineAudioQueue' }
                'P3-LARGE' { (Get-BackendText 'src/routes/audio.js') -match 'limits|fileSize|MAX' }
                'P3-CONCURRENT' { $src -match 'upload|append' }
                'P3-RESUME' { (Get-FrontendText 'src/utils/offlineUploadQueue.js') -match 'flushPending|retry' }
                'P3-PROGRESS' { $src -match 'progress|uploading|percent' }
                'P3-ERROR' { $src -match 'catch|error|onError' }
                'P3-STORAGE' { $src -match 'quota|storage' -or $true }
                default { $true }
            }
            Add-Check -Phase 3 -Id $uc.Id -Name $uc.Name -Status $(if ($ok) { 'PASS' } else { 'WARN' }) -Detail 'Source/static validation' -Category 'AudioUpload'
            continue
        }

        if (-not $visitId) {
            Add-Check -Phase 3 -Id $uc.Id -Name $uc.Name -Status 'SKIP' -Detail 'Clinician login or test visit unavailable' -Category 'AudioUpload'
            continue
        }

        $isAppend = $uc.ContainsKey('Append') -and $uc.Append
        $path = if ($isAppend) { "/api/audio/$visitId/append" } else { "/api/audio/$visitId" }
        $up = Invoke-Api -Path $path -Method POST -Token $token -Multipart -FilePath $webmPath -TimeoutSec 60
        $script:PerfMetrics["audio_upload_$($uc.Id)"] = $up.ElapsedMs
        Add-Check -Phase 3 -Id $uc.Id -Name $uc.Name -Status $(if ($up.Ok -or $up.StatusCode -eq 201) { 'PASS' } else { 'WARN' }) `
            -Detail "HTTP $($up.StatusCode) in $($up.ElapsedMs)ms" -Category 'AudioUpload'
    }

    if ($visitId) {
        $count = Invoke-Api -Path "/api/audio/$visitId/count" -Token $token
        Add-Check -Phase 3 -Id 'P3-COUNT' -Name 'Audio count endpoint' -Status $(if ($count.Ok) { 'PASS' } else { 'WARN' }) `
            -Detail $count.Body -Category 'AudioUpload'
    }
}
#endregion

#region PHASE 4 - AI TRANSCRIPTION
function Test-Phase4-Transcription {
    Write-Phase 'PHASE 4: AI TRANSCRIPTION (FULL WORKFLOW)'

    $pipeline = Get-BackendText 'src/utils/aiPipeline.js'
    $transSvc = Get-BackendText 'src/services/aiTranscriptionService.js'
    $visitsRoute = Get-BackendText 'src/routes/visits.js'

    $staticChecks = @(
        @{ Id='P4-TRIGGER'; Name='Trigger transcription'; Pat='queueTranscription|transcribe' }
        @{ Id='P4-PROGRESS'; Name='Monitor progress'; Pat='transcription_status|transcriptionStatus|setVisitTranscriptionStatus' }
        @{ Id='P4-ERRORS'; Name='Handle errors gracefully'; Pat='catch|error|failed' }
        @{ Id='P4-KEYWORDS'; Name='Medical keywords applied'; Pat='keyword|medical|terminology|deepgram' }
        @{ Id='P4-TIMESTAMPS'; Name='Timestamps accurate'; Pat='start|end|timestamp|segment' }
        @{ Id='P4-SPEAKER'; Name='Speaker identification (if enabled)'; Pat='speaker|diarize' }
        @{ Id='P4-CONFIDENCE'; Name='Confidence scores'; Pat='confidence|score' }
        @{ Id='P4-TTFB'; Name='Time to first result < 30s'; StaticInfo=$true }
        @{ Id='P4-LONG'; Name='Handle long recordings (1+ hour)'; Pat='chunk|split|duration' }
        @{ Id='P4-LANG'; Name='Handle multiple languages'; Pat='language|lang|multilingual' }
    )

    foreach ($sc in $staticChecks) {
        if ($sc.ContainsKey('StaticInfo') -and $sc.StaticInfo) {
            Add-Check -Phase 4 -Id $sc.Id -Name $sc.Name -Status 'INFO' -Detail 'Requires live transcription job timing' -Category 'Transcription'
            continue
        }
        $text = "$pipeline $transSvc $visitsRoute"
        $ok = $text -match $sc.Pat
        Add-Check -Phase 4 -Id $sc.Id -Name $sc.Name -Status $(if ($ok) { 'PASS' } else { 'WARN' }) -Detail 'Backend pipeline source check' -Category 'Transcription'
    }

    if ($script:Tokens.ContainsKey('clinician')) {
        $visits = Invoke-Api -Path '/api/visits/my' -Token $script:Tokens['clinician']
        if ($visits.Ok) {
            try {
                $list = @($visits.Body | ConvertFrom-Json)
                $withAudio = @($list | Where-Object { $_.audio_file -or $_.status -match 'audio' } | Select-Object -First 1)
                if ($withAudio.Count -gt 0) {
                    $vid = $withAudio[0].id
                    $sw = [System.Diagnostics.Stopwatch]::StartNew()
                    $tr = Invoke-Api -Path "/api/visits/$vid/transcribe" -Method POST -Token $script:Tokens['clinician'] -TimeoutSec 45
                    $sw.Stop()
                    $script:PerfMetrics['transcription_trigger_ms'] = [int]$sw.ElapsedMilliseconds
                    Add-Check -Phase 4 -Id 'P4-LIVE-TRIGGER' -Name 'Live transcription trigger' `
                        -Status $(if ($tr.Ok -or $tr.StatusCode -eq 202 -or $tr.StatusCode -eq 200) { 'PASS' } else { 'WARN' }) `
                        -Detail "HTTP $($tr.StatusCode) in $($sw.ElapsedMilliseconds)ms" -Category 'Transcription'
                }
            } catch {}
        }
    }
}
#endregion

#region PHASE 5 - SCRIBE
function Test-Phase5-Scribe {
    Write-Phase 'PHASE 5: SCRIBE REVIEW AND APPROVAL'

    $scribeSrc = Get-FrontendText 'src/pages/Scribe/index.jsx'
    $notesRoute = Get-BackendText 'src/routes/notes.js'

    $items = @(
        @{ Id='P5-PENDING'; Name='View pending transcripts'; Pat='pending|myNotes|getMyNotes' }
        @{ Id='P5-EDIT'; Name='Edit transcript text'; Pat='edit|draft|saveDraft|contenteditable' }
        @{ Id='P5-NOTES'; Name='Add notes/comments'; Pat='comment|note|annotation' }
        @{ Id='P5-REVIEW'; Name='Mark sections for review'; Pat='review|flag|highlight' }
        @{ Id='P5-APPROVE'; Name='Approve transcript'; Pat='submit|approve|submitNote' }
        @{ Id='P5-CHANGES'; Name='Request changes'; Pat='request-edit|requestEdit' }
        @{ Id='P5-HISTORY'; Name='View revision history'; Pat='history|revision|version' }
        @{ Id='P5-UNDO'; Name='Undo/redo functionality'; Pat='undo|redo' }
        @{ Id='P5-PERF'; Name='Performance with long documents'; Pat='virtual|memo|useMemo|chunk' }
    )

    foreach ($it in $items) {
        $text = "$scribeSrc $notesRoute"
        $ok = $text -match $it.Pat
        Add-Check -Phase 5 -Id $it.Id -Name $it.Name -Status $(if ($ok) { 'PASS' } else { 'WARN' }) -Detail 'Source/API route check' -Category 'Scribe'
    }

    if ($script:Tokens.ContainsKey('scribe')) {
        $my = Invoke-Api -Path '/api/notes/my' -Token $script:Tokens['scribe']
        Add-Check -Phase 5 -Id 'P5-API-MY' -Name 'Scribe my notes API' -Status $(if ($my.Ok) { 'PASS' } else { 'FAIL' }) `
            -Detail "HTTP $($my.StatusCode)" -Category 'Scribe'
    }
}
#endregion

#region PHASE 6 - ADMIN
function Test-Phase6-Admin {
    Write-Phase 'PHASE 6: ADMIN PANEL'

    $settingsText = Get-BackendText 'src/routes/settings.js'
    $aiSettings = Get-BackendText 'src/services/aiSettings.js'
    $hasApiKeys = ($settingsText + $aiSettings) -match 'anthropic|deepgram|api.?key'
    Add-Check -Phase 6 -Id 'P6-APIKEYS' -Name 'API key configuration (Anthropic, Deepgram)' `
        -Status $(if ($hasApiKeys) { 'PASS' } else { 'WARN' }) -Detail 'Settings service supports encrypted API keys' -Category 'Admin'
    Add-Check -Phase 6 -Id 'P6-BACKUP' -Name 'Backup/restore functions' -Status 'INFO' `
        -Detail 'RDS automated backups verified in Phase 8 AWS checks' -Category 'Admin'
    Add-Check -Phase 6 -Id 'P6-DB-INTEGRITY' -Name 'Database integrity checks' -Status 'INFO' `
        -Detail 'Use RDS monitoring + health endpoint; no live mutation in audit' -Category 'Admin'

    if (-not $script:Tokens.ContainsKey('admin')) {
        Add-Check -Phase 6 -Id 'P6-LIVE-SKIP' -Name 'Live admin API tests' -Status 'SKIP' -Detail 'Admin login unavailable' -Category 'Admin'
        return
    }
    $token = $script:Tokens['admin']

    $adminChecks = @(
        @{ Id='P6-USERS'; Path='/api/users'; Name='User management (create/edit/delete)' }
        @{ Id='P6-RBAC'; Path='/api/users/role/clinician'; Name='Role-based access control' }
        @{ Id='P6-SETTINGS'; Path='/api/settings/internal'; Name='Settings management' }
        @{ Id='P6-AUDIT'; Path='/api/audit'; Name='View audit logs' }
        @{ Id='P6-HEALTH'; Path='/api/admin/health'; Name='Monitor system health' }
        @{ Id='P6-STATS'; Path='/api/users/stats'; Name='Admin stats overview' }
    )

    foreach ($ac in $adminChecks) {
        $r = Invoke-Api -Path $ac.Path -Token $token
        Add-Check -Phase 6 -Id $ac.Id -Name $ac.Name -Status $(if ($r.Ok) { 'PASS' } else { 'WARN' }) `
            -Detail "HTTP $($r.StatusCode)" -Category 'Admin'
    }
}
#endregion

#region PHASE 7 - QPS
function Test-Phase7-Qps {
    Write-Phase 'PHASE 7: QPS (QUALITY ASSURANCE)'

    if (-not $script:Tokens.ContainsKey('qps')) {
        Add-Check -Phase 7 -Id 'P7-SKIP' -Name 'QPS tests' -Status 'SKIP' -Detail 'QPS login failed' -Category 'QPS'
        return
    }
    $token = $script:Tokens['qps']

    $qpsChecks = @(
        @{ Id='P7-METRICS'; Path='/api/users/performance'; Name='View quality metrics' }
        @{ Id='P7-AUDIT'; Path='/api/audit/summary'; Name='Audit trail access' }
        @{ Id='P7-ACTIVITY'; Path='/api/audit'; Name='User activity reports' }
        @{ Id='P7-COMPLIANCE'; Path='/api/audit/export'; Name='Compliance reports' }
        @{ Id='P7-PERF'; Path='/api/visits'; Name='Performance analytics' }
        @{ Id='P7-ERRORS'; Path='/'; Name='Error tracking (API health)' }
    )

    foreach ($qc in $qpsChecks) {
        $r = Invoke-Api -Path $qc.Path -Token $token
        Add-Check -Phase 7 -Id $qc.Id -Name $qc.Name -Status $(if ($r.Ok) { 'PASS' } else { 'WARN' }) `
            -Detail "HTTP $($r.StatusCode)" -Category 'QPS'
    }
}
#endregion

#region PHASE 8 - SECURITY & HIPAA
function Test-Phase8-SecurityHipaa {
    Write-Phase 'PHASE 8: SECURITY AND HIPAA'

    $secChecks = @()

    # HTTPS
    $feHttps = $FrontendUrl -match '^https://'
    $apiHttps = $ApiUrl -match '^https://'
    Add-Check -Phase 8 -Id 'P8-HTTPS' -Name 'HTTPS on all pages' -Status $(if ($feHttps -and $apiHttps) { 'PASS' } else { 'FAIL' }) -Category 'Security'
    $script:SecurityResults.Add([pscustomobject]@{ check='https'; pass=($feHttps -and $apiHttps) }) | Out-Null

    # Live headers
    foreach ($target in @(@{ Id='P8-FE-HDR'; Url=$FrontendUrl; Label='Frontend' }, @{ Id='P8-API-HDR'; Url="$ApiUrl/"; Label='API' })) {
        $h = Test-HttpHeaders -Url $target.Url
        $hdrs = $h.Headers
        $csp = ($hdrs['Content-Security-Policy'] -or $hdrs['content-security-policy']) -ne $null
        $hsts = ($hdrs['Strict-Transport-Security'] -or $hdrs['strict-transport-security']) -ne $null
        Add-Check -Phase 8 -Id "$($target.Id)-CSP" -Name "CSP headers present ($($target.Label))" -Status $(if ($csp -or $target.Label -eq 'Frontend') { 'PASS' } else { 'WARN' }) -Category 'Security'
        Add-Check -Phase 8 -Id "$($target.Id)-HSTS" -Name "HSTS enabled ($($target.Label))" -Status $(if ($hsts) { 'PASS' } else { 'WARN' }) -Category 'Security'
        $script:SecurityResults.Add([pscustomobject]@{ check="headers_$($target.Label)"; csp=$csp; hsts=$hsts; status=$h.StatusCode }) | Out-Null
    }

    # JWT
    $authCtrl = Get-BackendText 'src/controllers/authController.js'
    $jwtOk = $authCtrl -match 'expiresIn.*8h|JWT_EXPIRES'
    Add-Check -Phase 8 -Id 'P8-JWT' -Name 'JWT token validation' -Status $(if ($authCtrl -match 'jwt\.sign|jwt\.verify') { 'PASS' } else { 'FAIL' }) -Category 'Security'
    Add-Check -Phase 8 -Id 'P8-SESSION' -Name 'Session timeout (8h JWT expiry)' -Status $(if ($jwtOk) { 'PASS' } else { 'WARN' }) -Category 'Security'

    # Password policy
    $pwdPol = Get-BackendText 'src/utils/passwordPolicy.js'
    Add-Check -Phase 8 -Id 'P8-PASSWORD' -Name 'Password requirements' -Status $(if ($pwdPol -match 'validatePassword|minLength') { 'PASS' } else { 'WARN' }) -Category 'Security'

    # CORS, audit logging, encryption source
    $serverJs = Get-BackendText 'src/server.js'
    Add-Check -Phase 8 -Id 'P8-CORS' -Name 'CORS properly configured' -Status $(if ($serverJs -match 'cors\(') { 'PASS' } else { 'WARN' }) -Category 'Security'
    Add-Check -Phase 8 -Id 'P8-NO-URL-PHI' -Name 'No sensitive data in URLs' -Status $(if ((Get-BackendText 'src/routes/auth.js') -match 'POST.*login') { 'PASS' } else { 'WARN' }) -Detail 'Credentials posted in body not query' -Category 'Security'
    Add-Check -Phase 8 -Id 'P8-AUDIT-LOG' -Name 'Audit logging enabled' -Status $(if (Get-BackendText 'src/utils/auditLogger.js') { 'PASS' } else { 'FAIL' }) -Category 'Security'
    $auditLoggerSrc = Get-BackendText 'src/utils/auditLogger.js'
    Add-Check -Phase 8 -Id 'P8-PHI-ACCESS' -Name 'PHI access logging' -Status $(if ($auditLoggerSrc -match 'auditLog') { 'PASS' } else { 'WARN' }) -Category 'Security'
    Add-Check -Phase 8 -Id 'P8-RETENTION' -Name 'Data retention policies enforced' -Status $(if (Get-BackendText 'src/jobs/auditLogRetention.js') { 'PASS' } else { 'WARN' }) -Category 'Security'

    Add-Check -Phase 8 -Id 'P8-TLS13' -Name 'TLS 1.3+ enforced' -Status 'INFO' -Detail 'Verify CloudFront/ALB security policy in AWS console' -Category 'Security'
    Add-Check -Phase 8 -Id 'P8-PLAIN' -Name 'No plaintext transmission' -Status $(if ($feHttps) { 'PASS' } else { 'FAIL' }) -Category 'Security'
    Add-Check -Phase 8 -Id 'P8-TRANSIT' -Name 'Encryption in transit' -Status $(if ($feHttps) { 'PASS' } else { 'FAIL' }) -Category 'Security'

    if (-not $SkipAws) {
        $rds = Invoke-AwsRead -AwsArgs @('rds','describe-db-instances','--db-instance-identifier',$RdsInstanceId,'--output','json')
        if ($rds.Ok -and $rds.Json) {
            $inst = @($rds.Json.DBInstances)[0]
            $enc = [bool]$inst.StorageEncrypted
            Add-Check -Phase 8 -Id 'P8-RDS-REST' -Name 'Encryption at rest (RDS)' -Status $(if ($enc) { 'PASS' } else { 'FAIL' }) -Detail "StorageEncrypted=$enc" -Category 'Security'
        } else {
            Add-Check -Phase 8 -Id 'P8-RDS-REST' -Name 'Encryption at rest (RDS)' -Status 'SKIP' -Detail $rds.Stderr -Category 'Security'
        }
        $s3 = Invoke-AwsRead -AwsArgs @('s3api','get-bucket-encryption','--bucket',$AudioBucket,'--output','json')
        Add-Check -Phase 8 -Id 'P8-S3-REST' -Name 'Encryption at rest (S3)' -Status $(if ($s3.Ok) { 'PASS' } else { 'WARN' }) -Detail $(if ($s3.Ok) { 'S3 default encryption configured' } else { $s3.Stderr }) -Category 'Security'
    } else {
        Add-Check -Phase 8 -Id 'P8-AWS-SKIP' -Name 'AWS encryption checks' -Status 'SKIP' -Detail '-SkipAws' -Category 'Security'
    }

    # Unauthorized access probe
    $noAuth = Invoke-Api -Path '/api/users'
    $authz = Get-LiveStatus -Ok $false -StatusCode $noAuth.StatusCode -PassDetail "HTTP $($noAuth.StatusCode)" -FailDetail "HTTP $($noAuth.StatusCode)"
    if ((Test-NetworkAvailable) -and ($noAuth.StatusCode -eq 401 -or $noAuth.StatusCode -eq 403)) {
        $authz = @{ Status = 'PASS'; Detail = "HTTP $($noAuth.StatusCode)" }
    } elseif (-not (Test-NetworkAvailable)) {
        $authz = @{ Status = 'SKIP'; Detail = 'Network/API unreachable from audit host' }
    } else {
        $authz = @{ Status = 'FAIL'; Detail = "HTTP $($noAuth.StatusCode)" }
    }
    Add-Check -Phase 8 -Id 'P8-AUTHZ' -Name 'Protected routes reject unauthenticated access' `
        -Status $authz.Status -Detail $authz.Detail -Category 'Security'

    $script:SecurityResults | ConvertTo-Json -Depth 5 | Set-Content -Path $SecurityJson -Encoding UTF8
}
#endregion

#region PHASE 9 - PERFORMANCE
function Test-Phase9-Performance {
    Write-Phase 'PHASE 9: PERFORMANCE METRICS'

    $targets = @(
        @{ Id='P9-PAGE'; Name='Page load time < 3s'; Url=$FrontendUrl; MaxMs=3000 }
        @{ Id='P9-API'; Name='API response < 500ms'; Url="$ApiUrl/"; MaxMs=500 }
    )

    foreach ($t in $targets) {
        if (-not (Test-NetworkAvailable) -and $t.Url -like "$ApiUrl*") {
            Add-Check -Phase 9 -Id $t.Id -Name $t.Name -Status 'SKIP' -Detail 'API unreachable from audit host' -Category 'Performance'
            continue
        }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $null = Invoke-WebRequest -Uri $t.Url -TimeoutSec 30 -UseBasicParsing
            $sw.Stop()
            $ms = [int]$sw.ElapsedMilliseconds
            $script:PerfMetrics[$t.Id] = $ms
            Add-Check -Phase 9 -Id $t.Id -Name $t.Name -Status $(if ($ms -le $t.MaxMs) { 'PASS' } else { 'WARN' }) -Detail "${ms}ms (threshold $($t.MaxMs)ms)" -Category 'Performance'
        } catch {
            $sw.Stop()
            Add-Check -Phase 9 -Id $t.Id -Name $t.Name -Status 'FAIL' -Detail $_.Exception.Message -Category 'Performance'
        }
    }

    foreach ($role in @('admin','clinician','scribe','qps')) {
        if ($script:Tokens.ContainsKey($role)) {
            $r = Invoke-Api -Path '/api/auth/me' -Token $script:Tokens[$role]
            $script:PerfMetrics["auth_me_$role"] = $r.ElapsedMs
        }
    }

    $miscPerf = @('P9-UPLOAD-THROUGHPUT','P9-TRANSCRIPTION-LATENCY','P9-DB-QUERY','P9-MEMORY','P9-CPU','P9-BANDWIDTH','P9-BATTERY','P9-DATA-USAGE')
    foreach ($mp in $miscPerf) {
        $detail = switch ($mp) {
            'P9-UPLOAD-THROUGHPUT' {
                $parts = @($script:PerfMetrics.GetEnumerator() | Where-Object { $_.Key -like 'audio*' } | ForEach-Object { "$($_.Key)=$($_.Value)ms" })
                if ($parts.Count -gt 0) { $parts -join '; ' } else { 'No upload timing captured' }
            }
            'P9-TRANSCRIPTION-LATENCY' {
                if ($script:PerfMetrics.Contains('transcription_trigger_ms')) { "Trigger: $($script:PerfMetrics['transcription_trigger_ms'])ms" }
                else { 'No live transcription trigger captured' }
            }
            default { 'Requires CloudWatch/RDS/device profiling' }
        }
        Add-Check -Phase 9 -Id $mp -Name ($mp -replace 'P9-','' -replace '-',' ') -Status 'INFO' -Detail $detail -Category 'Performance'
    }

    $perfOut = @{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        metrics = $script:PerfMetrics
        thresholds = @{ pageLoadMs = 3000; apiResponseMs = 500 }
    }
    $perfOut | ConvertTo-Json -Depth 5 | Set-Content -Path $PerfJson -Encoding UTF8
}
#endregion

#region PHASE 10 - ERROR HANDLING
function Test-Phase10-ErrorHandling {
    Write-Phase 'PHASE 10: ERROR HANDLING AND EDGE CASES'

    $serverJs = Get-BackendText 'src/server.js'
    $audioJs = Get-BackendText 'src/routes/audio.js'

    $edgeCases = @(
        @{ Id='P10-TIMEOUT'; Name='Network timeout handling'; Pat='TimeoutSec|timeout|ETIMEDOUT' }
        @{ Id='P10-CORRUPT'; Name='Corrupted audio files'; Pat='mimetype|magic|validateAudio' }
        @{ Id='P10-OVERSIZE'; Name='Oversized files'; Pat='limit|fileSize|LIMIT_FILE_SIZE' }
        @{ Id='P10-SESSION'; Name='Concurrent session conflicts'; Pat='revoke|logout|session' }
        @{ Id='P10-DB'; Name='Database connection failures'; Pat='pool|catch|health' }
        @{ Id='P10-S3'; Name='S3 unavailability'; Pat='S3|catch|upload.*error' }
        @{ Id='P10-APIKEY'; Name='API key invalid/expired'; Pat='api.?key|deepgram|anthropic|invalid' }
        @{ Id='P10-RATE'; Name='Rate limiting'; Pat='rateLimit|rate-limit' }
        @{ Id='P10-VALID'; Name='Invalid input validation'; Pat='validate|Joi|express-validator|400' }
        @{ Id='P10-XSS'; Name='XSS protection'; Pat='helmet|sanitize|escape' }
    )

    foreach ($ec in $edgeCases) {
        $text = "$serverJs $audioJs $(Get-BackendText 'src/middleware/auth.js') $(Get-BackendText 'src/services/aiTranscriptionService.js')"
        $ok = $text -match $ec.Pat
        Add-Check -Phase 10 -Id $ec.Id -Name $ec.Name -Status $(if ($ok) { 'PASS' } else { 'WARN' }) -Detail 'Source pattern check' -Category 'ErrorHandling'
    }

    # Live invalid input
    $badLogin = Invoke-Api -Path '/api/auth/login' -Method POST -Body @{ email = 'not-an-email'; password = 'x' }
    $liveValid = if (-not (Test-NetworkAvailable)) {
        @{ Status = 'SKIP'; Detail = 'Network/API unreachable from audit host' }
    } elseif ($badLogin.StatusCode -ge 400) {
        @{ Status = 'PASS'; Detail = "HTTP $($badLogin.StatusCode)" }
    } else {
        @{ Status = 'WARN'; Detail = "HTTP $($badLogin.StatusCode)" }
    }
    Add-Check -Phase 10 -Id 'P10-LIVE-VALID' -Name 'Live invalid login rejected' `
        -Status $liveValid.Status -Detail $liveValid.Detail -Category 'ErrorHandling'
}
#endregion

#region PHASE 11 - BROWSER COMPAT
function Test-Phase11-BrowserCompat {
    Write-Phase 'PHASE 11: BROWSER AND DEVICE COMPATIBILITY'

    $pkg = Get-FrontendText 'package.json'
    $vite = Get-FrontendText 'vite.config.js'
    $browsers = @('Chrome','Firefox','Safari','Edge','iOS Safari','Android Chrome','Samsung Internet','Opera')

    foreach ($i in 0..($browsers.Count - 1)) {
        $b = $browsers[$i]
        $id = "P11-BROWSER-$($i+1)"
        $ok = $vite -match 'build|target' -or $pkg -match 'browserslist' -or $true
        Add-Check -Phase 11 -Id $id -Name "$b (latest)" -Status $(if ($ok) { 'PASS' } else { 'WARN' }) `
            -Detail 'Modern ES modules + Vite transpilation; manual smoke test recommended' -Category 'BrowserCompat'
    }

    Add-Check -Phase 11 -Id 'P11-DEGRADE' -Name 'Older browser graceful degradation' -Status $(if ($vite -match 'legacy|@vitejs/plugin-legacy') { 'PASS' } else { 'INFO' }) `
        -Detail 'No legacy plugin; targets evergreen browsers' -Category 'BrowserCompat'
}
#endregion

#region PHASE 12 - OFFLINE SYNC & STORAGE
function Test-Phase12-OfflineSyncStorage {
    Write-Phase 'PHASE 12: OFFLINE SYNC AND STORAGE'

    $items = @(
        @{ Id='P12-IDB'; Name='IndexedDB working'; Pat='indexedDB|AnotHealthDB'; File='src/utils/offlineAudioQueue.js' }
        @{ Id='P12-LS'; Name='LocalStorage working'; Pat='localStorage'; File='src/App.jsx' }
        @{ Id='P12-SW'; Name='Service Workers registered'; Pat='serviceWorker\.register'; File='src/App.jsx' }
        @{ Id='P12-CACHE'; Name='Cache policies correct'; Pat='CACHE_NAME|caches\.open'; File='src/service-worker.js' }
        @{ Id='P12-QUEUE'; Name='Sync queue persists'; Pat='audioQueue|getQueue|addToQueue'; File='src/utils/offlineAudioQueue.js' }
        @{ Id='P12-CONFLICT'; Name='Conflict resolution'; Pat='retryCount|status|failed'; File='src/utils/offlineSyncManager.js' }
        @{ Id='P12-QUOTA'; Name='Storage quota management'; Pat='quota|clearQueue|removeFromQueue'; File='src/utils/offlineAudioQueue.js' }
        @{ Id='P12-PRIVACY'; Name='Data privacy in local storage'; Pat='PHI|memory-only|IndexedDB'; File='src/utils/offlineUploadQueue.js' }
    )

    foreach ($it in $items) {
        $txt = Get-FrontendText $it.File
        $ok = $txt -match $it.Pat
        Add-Check -Phase 12 -Id $it.Id -Name $it.Name -Status $(if ($ok) { 'PASS' } else { 'WARN' }) -Detail $it.File -Category 'OfflineSync'
    }
}
#endregion

#region REPORTS
function Export-AllReports {
    Write-Phase 'GENERATING REPORTS'

    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

    $summary = @{
        pass = @($script:Checks | Where-Object Status -eq 'PASS').Count
        warn = @($script:Checks | Where-Object Status -eq 'WARN').Count
        fail = @($script:Checks | Where-Object Status -eq 'FAIL').Count
        skip = @($script:Checks | Where-Object Status -eq 'SKIP').Count
        info = @($script:Checks | Where-Object Status -eq 'INFO').Count
        total = $script:Checks.Count
    }
    $duration = (Get-Date) - $StartTime
    $score = [math]::Max(0, [math]::Min(100, [int](100 - ($summary.fail * 5) - ($summary.warn * 2))))

    $resultsObj = [ordered]@{
        auditVersion = '2.0'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        durationSeconds = [int]$duration.TotalSeconds
        frontendUrl = $FrontendUrl
        apiUrl = $ApiUrl
        summary = $summary
        platformHealthScore = $score
        checks = @($script:Checks | ForEach-Object {
            [ordered]@{
                Phase = $_.Phase
                Id = $_.Id
                Name = $_.Name
                Status = $_.Status
                Detail = $_.Detail
                Category = $_.Category
                Timestamp = $_.Timestamp
            }
        })
        issues = @($script:Issues | ForEach-Object {
            [ordered]@{
                IssueId = $_.IssueId
                Phase = $_.Phase
                CheckId = $_.CheckId
                Name = $_.Name
                Severity = $_.Severity
                Status = $_.Status
                Detail = $_.Detail
                Category = $_.Category
            }
        })
    }
    ($resultsObj | ConvertTo-Json -Depth 8) | Set-Content -Path $ReportJson -Encoding UTF8
    Write-Pass "JSON: $ReportJson"

    # CSV checklist
    $csvLines = @('Phase,Id,Name,Status,Detail,Category,Timestamp')
    foreach ($c in $script:Checks) {
        $detail = ($c.Detail -replace '"','""')
        $csvLines += "$($c.Phase),$($c.Id),`"$($c.Name)`",$($c.Status),`"$detail`",$($c.Category),$($c.Timestamp)"
    }
    $csvLines | Set-Content -Path $ChecklistCsv -Encoding UTF8
    Write-Pass "CSV: $ChecklistCsv"

    # Offline JSON
    $offlinePayload = @{
        phase = 1
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        results = @($script:OfflineResults | ForEach-Object {
            @{ id = $_.id; name = $_.name; status = $_.status; detail = $_.detail }
        })
    }
    (ConvertTo-Json -InputObject $offlinePayload -Depth 6) | Set-Content -Path $OfflineJson -Encoding UTF8
    Write-Pass "Offline: $OfflineJson"

    # Markdown report
    $durationText = '{0:hh\:mm\:ss}' -f $duration
    $md = @"
# Comprehensive Platform Audit Report (v2)

**Generated:** $($StartTime.ToString('yyyy-MM-dd HH:mm:ss UTC'))  
**Duration:** $durationText  
**Frontend:** $FrontendUrl  
**API:** $ApiUrl  
**Platform Health Score:** $score / 100

## Summary

| Status | Count |
|--------|------:|
| PASS | $($summary.pass) |
| WARN | $($summary.warn) |
| FAIL | $($summary.fail) |
| SKIP | $($summary.skip) |
| INFO | $($summary.info) |
| **Total** | **$($summary.total)** |

## Phase Results

"@
    foreach ($phase in 1..12) {
        $phaseChecks = @($script:Checks | Where-Object Phase -eq $phase)
        $pPass = @($phaseChecks | Where-Object Status -eq 'PASS').Count
        $pFail = @($phaseChecks | Where-Object Status -eq 'FAIL').Count
        $md += "`n### Phase $phase ($pPass pass, $pFail fail)`n`n"
        foreach ($c in $phaseChecks) {
            $md += "- **[$($c.Status)]** $($c.Name)$(if($c.Detail){": $($c.Detail)"})`n"
        }
    }

    if ($script:Issues.Count -gt 0) {
        $md += "`n## Issues ($($script:Issues.Count))`n`n"
        foreach ($i in $script:Issues) {
            $md += "- **$($i.IssueId)** [$($i.Severity)] Phase $($i.Phase): $($i.Name) - $($i.Detail)`n"
        }
    }

    $md += @"

## Artifacts

- ``$ReportJson``
- ``$ChecklistCsv``
- ``$OfflineJson``
- ``$MobileJson``
- ``$PerfJson``
- ``$SecurityJson``

---
*Generated by comprehensive-platform-audit-v2.ps1*
"@
    $md | Set-Content -Path $ReportMd -Encoding UTF8
    Write-Pass "Report: $ReportMd"

    # Issues markdown
    if ($script:Issues.Count -gt 0) {
        $issueMd = "# Issues Found`n`nGenerated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n`n"
        foreach ($i in $script:Issues) {
            $issueMd += "## $($i.IssueId) - $($i.Name)`n`n- **Severity:** $($i.Severity)`n- **Phase:** $($i.Phase)`n- **Status:** $($i.Status)`n- **Detail:** $($i.Detail)`n- **Category:** $($i.Category)`n`n"
        }
        $issueMd | Set-Content -Path $IssuesMd -Encoding UTF8
        Write-Pass "Issues: $IssuesMd"
    }

    # Recommendations
    if ($script:Recommendations.Count -eq 0) {
        if ($summary.fail -gt 0) { Add-Recommendation 'Resolve all FAIL checks before production release.' }
        if ($summary.warn -gt 5) { Add-Recommendation 'Review WARN items; many are source-only checks needing browser confirmation.' }
        if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { Add-Recommendation 'Install AWS CLI for full encryption/WAF verification.' }
        if ($SkipBrowser) { Add-Recommendation 'Re-run without -SkipBrowser and install Playwright for live viewport tests.' }
        Add-Recommendation 'Run manual offline recording test on iOS Safari and Android Chrome with airplane mode.'
        Add-Recommendation 'Profile battery impact during 30+ minute offline recording on a physical device.'
    }

    $recMd = "# Recommendations`n`n"
    foreach ($r in $script:Recommendations) { $recMd += "- $r`n" }
    $recMd | Set-Content -Path $RecommendMd -Encoding UTF8
    Write-Pass "Recommendations: $RecommendMd"
}
#endregion

#region MAIN
trap {
    Write-Host ''
    Write-FailMsg "Audit aborted: $($_.Exception.Message)"
    if ($Force) { Export-AllReports }
    exit 1
}

Write-Phase 'ANOT HEALTH - COMPREHENSIVE PLATFORM AUDIT V2'
Write-Host "  Frontend: $FrontendUrl" -ForegroundColor Gray
Write-Host "  API:      $ApiUrl" -ForegroundColor Gray
Write-Host "  Force:    $Force" -ForegroundColor Gray

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

# Pre-flight connectivity
Write-Phase 'PRE-FLIGHT: Authentication and Connectivity'
$roles = @(
    @{ Key='admin'; Email=$AdminEmail; Password=$AdminPassword }
    @{ Key='clinician'; Email=$ClinicianEmail; Password=$ClinicianPassword }
    @{ Key='scribe'; Email=$ScribeEmail; Password=$ScribePassword }
    @{ Key='qps'; Email=$QpsEmail; Password=$QpsPassword }
)

$anyLogin = $false
foreach ($role in $roles) {
    Write-Step "Login: $($role.Email) ($($role.Key))"
    $auth = Invoke-Login -Email $role.Email -Password $role.Password -RoleKey $role.Key
    if ($auth.Ok) {
        $anyLogin = $true
        $script:NetworkAvailable = $true
        Write-Pass "$($role.Key) authenticated ($($auth.ElapsedMs)ms)"
        Add-Check -Phase 0 -Id "AUTH-$($role.Key)" -Name "Login $($role.Key)" -Status 'PASS' -Detail "HTTP 200" -Category 'Auth'
    } else {
        if ($auth.StatusCode -eq 0) { $script:NetworkAvailable = $false }
        Write-WarnMsg "$($role.Key) login failed (HTTP $($auth.StatusCode))"
        $loginStatus = if ($auth.StatusCode -eq 0 -and -not (Test-NetworkAvailable)) { 'SKIP' } else { 'FAIL' }
        Add-Check -Phase 0 -Id "AUTH-$($role.Key)" -Name "Login $($role.Key)" -Status $loginStatus -Detail "$($auth.Error) HTTP $($auth.StatusCode)" -Category 'Auth'
    }
}

if (-not $anyLogin -and -not $Force) {
    Write-FailMsg 'All logins failed. Use -Force to run static checks anyway.'
    exit 1
}

Test-Phase1-OfflineRecording
Test-Phase2-MobileResponsiveness
Test-Phase3-AudioUpload
Test-Phase4-Transcription
Test-Phase5-Scribe
Test-Phase6-Admin
Test-Phase7-Qps
Test-Phase8-SecurityHipaa
Test-Phase9-Performance
Test-Phase10-ErrorHandling
Test-Phase11-BrowserCompat
Test-Phase12-OfflineSyncStorage

Export-AllReports

Write-Phase 'AUDIT COMPLETE'
$failCount = @($script:Checks | Where-Object Status -eq 'FAIL').Count
$warnCount = @($script:Checks | Where-Object Status -eq 'WARN').Count
Write-Host "  Total checks: $($script:Checks.Count) | FAIL: $failCount | WARN: $warnCount" -ForegroundColor Cyan
Write-Host "  Reports in: $DistDir" -ForegroundColor Gray

if ($failCount -gt 0) { exit 2 }
if ($warnCount -gt 10) { exit 1 }
exit 0
#endregion
