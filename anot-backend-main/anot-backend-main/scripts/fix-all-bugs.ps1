<#
================================================================================
 fix-all-bugs.ps1  -  Apply (or rehearse) every automatable remediation surfaced
                      by audit-complete-platform.ps1, and print manual steps for
                      the rest.
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHAT THIS SCRIPT DOES:
   Reads dist/audit-complete-results.json (produced by audit-complete-platform.ps1),
   then for every finding that carries a known FixId it runs the matching
   automated remediation. Findings with no automated fix are printed as a clear,
   numbered MANUAL TODO list. Each automated fix is idempotent and re-runnable.

 THE FIX CATALOG (FixId -> action):
   npm-audit-backend    npm audit fix in the backend package.
   npm-audit-frontend   npm audit fix in the frontend package.
   purge-local-uploads  Delete locally-cached PHI audio under src/uploads (DESTRUCTIVE).
   clean-stale-dirs     Remove backup-v* / temp-extract* directories (DESTRUCTIVE).
   gitignore-env        git rm --cached a committed .env + ensure .gitignore covers it.
   set-log-retention    Set CloudWatch retention on EB log groups (AWS).
   fix-s3-security      Delegate to scripts/fix-s3-security.ps1.
   fix-waf-logging      Delegate to scripts/fix-waf-logging.ps1.
   fix-ssm-ops          Delegate to scripts/fix-ssm-ops-permissions.ps1.

 SAFETY:
   * -DryRun rehearses everything (prints the exact actions) and changes NOTHING.
   * Mutating steps prompt for confirmation unless -Force / -SkipConfirm.
   * DESTRUCTIVE fixes (purge-local-uploads, clean-stale-dirs) NEVER run unless
     you also pass -IncludeDestructive (so an accidental -Force can't wipe data).
   * If the audit JSON is missing, pass -All to run the full known-fix catalog.

 USAGE:
   powershell -File scripts/fix-all-bugs.ps1 -DryRun            # rehearse
   powershell -File scripts/fix-all-bugs.ps1 -Live              # apply (prompts)
   powershell -File scripts/fix-all-bugs.ps1 -Live -Force       # apply, no prompts
   powershell -File scripts/fix-all-bugs.ps1 -Live -Force -IncludeDestructive
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Live,
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$All,
    [switch]$IncludeDestructive,
    [switch]$SkipAws,
    [string]$AuditJson,
    [int]$RetentionDays = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$AwsAccountId = '625242092266'
$Region       = 'ap-southeast-1'
$EbEnvName    = 'anot-backend-prod'
$EbLogGroupPrefix = "/aws/elasticbeanstalk/$EbEnvName"

$ScriptDir    = $PSScriptRoot
$BackendDir   = Split-Path -Parent $ScriptDir
$WorkspaceDir = $BackendDir
for ($i = 0; $i -lt 4; $i++) {
    $candidate = (Resolve-Path (Join-Path $WorkspaceDir '..')).Path
    if (Test-Path (Join-Path $candidate 'anot-frontend-main')) { $WorkspaceDir = $candidate; break }
    $WorkspaceDir = $candidate
}
$FrontendDir = $null
foreach ($p in @(
    (Join-Path $WorkspaceDir 'anot-frontend-main\anot-frontend-main'),
    (Join-Path $WorkspaceDir 'anot-frontend-main')
)) { if (Test-Path $p) { $FrontendDir = $p; break } }

$ArtifactDir  = Join-Path $BackendDir 'dist'
if (-not $AuditJson) { $AuditJson = Join-Path $ArtifactDir 'audit-complete-results.json' }
$ResultJson   = Join-Path $ArtifactDir 'fix-all-bugs-results.json'
$Stamp        = Get-Date -Format 'yyyyMMdd-HHmmss'

# Default to LIVE if neither switch was given.
if (-not $DryRun -and -not $Live) { $Live = $true }
if ($DryRun) { $Live = $false }

$env:AWS_DEFAULT_REGION = $Region
$env:AWS_PAGER = ''
$script:CurrentPhase = 'startup'
$script:Actions = New-Object System.Collections.Generic.List[object]
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
    if ($DryRun)                 { Write-Step "[DRY-RUN] would prompt: $Message"; return $true }
    if ($Force -or $SkipConfirm) { Write-Step "$Message (auto-confirmed)"; return $true }
    $answer = Read-Host "  ?? $Message  [y/N]"
    return ($answer -match '^(y|yes)$')
}

function Add-Action {
    param([string]$FixId, [string]$Title, [ValidateSet('APPLIED','SKIPPED','FAILED','PLANNED','MANUAL')] [string]$Outcome, [string]$Detail = '')
    $rec = [pscustomobject]@{ FixId = $FixId; Title = $Title; Outcome = $Outcome; Detail = $Detail; At = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    $script:Actions.Add($rec)
    $color = switch ($Outcome) { 'APPLIED' { 'Green' } 'PLANNED' { 'DarkGray' } 'SKIPPED' { 'DarkGray' } 'MANUAL' { 'Yellow' } 'FAILED' { 'Red' } default { 'Gray' } }
    Write-Host "    [$Outcome] $Title" -ForegroundColor $color
    if ($Detail) { Write-Diag $Detail }
}

# Run a child command (npm, git, aws) capturing output. Returns @{ Ok; Out }.
function Invoke-Native {
    param([string]$File, [string[]]$Arguments, [string]$WorkDir = $null)
    $prev = $null
    if ($WorkDir) { $prev = Get-Location; Set-Location $WorkDir }
    $out = ''
    $code = 0
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $captured = & $File @Arguments 2>&1
        $code = $LASTEXITCODE
        $out = (@($captured) | ForEach-Object { [string]$_ }) -join "`n"
    }
    catch { $code = 9001; $out = $_.Exception.Message }
    finally {
        $ErrorActionPreference = $prevEap
        if ($prev) { Set-Location $prev }
    }
    return @{ Ok = ($code -eq 0); Code = $code; Out = $out }
}

# Delegate to a sibling fix-*.ps1, forwarding -DryRun / -Force appropriately.
function Invoke-FixScript {
    param([string]$ScriptName)
    $path = Join-Path $ScriptDir $ScriptName
    if (-not (Test-Path $path)) {
        Add-Action -FixId $ScriptName -Title "Delegate to $ScriptName" -Outcome 'FAILED' -Detail "Script not found at $path."
        return
    }
    $fwd = @{}
    if ($DryRun) { $fwd['DryRun'] = $true } else { $fwd['Force'] = $true }
    Write-Step "Running $ScriptName $(if ($DryRun) { '-DryRun' } else { '-Force' }) ..."
    try {
        & $path @fwd
        $ok = ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE)
        Add-Action -FixId $ScriptName -Title "Delegate to $ScriptName" -Outcome $(if ($DryRun) { 'PLANNED' } elseif ($ok) { 'APPLIED' } else { 'FAILED' }) -Detail "exit=$LASTEXITCODE"
    }
    catch {
        Add-Action -FixId $ScriptName -Title "Delegate to $ScriptName" -Outcome 'FAILED' -Detail $_.Exception.Message
    }
}
#endregion

trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  FIX-ALL-BUGS FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    Write-Host ''
    exit 1
}

# =============================================================================
# PRE-FLIGHT
# =============================================================================
Write-Phase 'PRE-FLIGHT: load audit findings + capability check'

if ($DryRun) { Write-Warn 'DRY-RUN MODE: every fix is rehearsed; nothing is changed.' }
else         { Write-Step 'LIVE MODE: automated fixes will be applied (mutating steps prompt unless -Force).' }

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null

# Collect the set of FixIds + manual findings to act on.
$wantedFixes = New-Object System.Collections.Generic.List[string]
$manualFindings = New-Object System.Collections.Generic.List[object]

if (Test-Path $AuditJson) {
    Write-Step "Reading audit findings from $AuditJson"
    $audit = Get-Content -Raw -Path $AuditJson | ConvertFrom-Json
    $findings = @($audit.findings)
    Write-Diag "audit score: $($audit.summary.score)/100; findings: $($findings.Count)"
    foreach ($f in $findings) {
        if ($f.auto -and $f.fixId) { if (-not $wantedFixes.Contains($f.fixId)) { $wantedFixes.Add($f.fixId) } }
        elseif (-not $f.auto) { $manualFindings.Add($f) }
    }
} else {
    Write-Warn "Audit JSON not found at $AuditJson."
    if (-not $All) {
        Write-Warn 'Run audit-complete-platform.ps1 first, or pass -All to run the full known-fix catalog.'
    }
}

if ($All) {
    foreach ($id in @('npm-audit-backend','npm-audit-frontend','set-log-retention','fix-s3-security','fix-waf-logging','fix-ssm-ops')) {
        if (-not $wantedFixes.Contains($id)) { $wantedFixes.Add($id) }
    }
    if ($IncludeDestructive) {
        foreach ($id in @('purge-local-uploads','clean-stale-dirs')) { if (-not $wantedFixes.Contains($id)) { $wantedFixes.Add($id) } }
    }
}

$awsReady = $false
if (-not $SkipAws -and (Get-Command aws -ErrorAction SilentlyContinue)) {
    $idOut = Invoke-Native -File 'aws' -Arguments @('sts','get-caller-identity','--output','json')
    if ($idOut.Ok) { $awsReady = $true; Write-Diag 'AWS identity verified.' }
    else { Write-Warn 'AWS identity not available; AWS-backed fixes will be skipped.' }
}

Write-Step "Fixes queued: $(if ($wantedFixes.Count) { ($wantedFixes -join ', ') } else { '(none)' })"

# =============================================================================
# AUTOMATED FIXES
# =============================================================================
Write-Phase 'AUTOMATED FIXES'

function Has-Fix { param([string]$Id) return $wantedFixes.Contains($Id) }

# ---- npm audit fix (backend) ----
if (Has-Fix 'npm-audit-backend') {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Add-Action -FixId 'npm-audit-backend' -Title 'Backend npm audit fix' -Outcome 'SKIPPED' -Detail 'npm not on PATH.'
    } elseif ($DryRun) {
        Add-Action -FixId 'npm-audit-backend' -Title 'Backend npm audit fix' -Outcome 'PLANNED' -Detail "would run: npm audit fix (in $BackendDir)"
    } elseif (Confirm-Step "Run 'npm audit fix' in the backend package?") {
        $r = Invoke-Native -File 'npm' -Arguments @('audit','fix') -WorkDir $BackendDir
        Add-Action -FixId 'npm-audit-backend' -Title 'Backend npm audit fix' -Outcome $(if ($r.Ok) { 'APPLIED' } else { 'FAILED' }) -Detail ($r.Out -split "`n" | Select-Object -Last 1)
    } else { Add-Action -FixId 'npm-audit-backend' -Title 'Backend npm audit fix' -Outcome 'SKIPPED' -Detail 'declined.' }
}

# ---- npm audit fix (frontend) ----
if (Has-Fix 'npm-audit-frontend') {
    if (-not $FrontendDir) {
        Add-Action -FixId 'npm-audit-frontend' -Title 'Frontend npm audit fix' -Outcome 'SKIPPED' -Detail 'frontend dir not found.'
    } elseif (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Add-Action -FixId 'npm-audit-frontend' -Title 'Frontend npm audit fix' -Outcome 'SKIPPED' -Detail 'npm not on PATH.'
    } elseif ($DryRun) {
        Add-Action -FixId 'npm-audit-frontend' -Title 'Frontend npm audit fix' -Outcome 'PLANNED' -Detail "would run: npm audit fix (in $FrontendDir)"
    } elseif (Confirm-Step "Run 'npm audit fix' in the frontend package?") {
        $r = Invoke-Native -File 'npm' -Arguments @('audit','fix') -WorkDir $FrontendDir
        Add-Action -FixId 'npm-audit-frontend' -Title 'Frontend npm audit fix' -Outcome $(if ($r.Ok) { 'APPLIED' } else { 'FAILED' }) -Detail ($r.Out -split "`n" | Select-Object -Last 1)
    } else { Add-Action -FixId 'npm-audit-frontend' -Title 'Frontend npm audit fix' -Outcome 'SKIPPED' -Detail 'declined.' }
}

# ---- gitignore + untrack committed env file ----
if (Has-Fix 'gitignore-env') {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Add-Action -FixId 'gitignore-env' -Title 'Untrack committed .env' -Outcome 'SKIPPED' -Detail 'git not on PATH.'
    } else {
        $tracked = @()
        $ls = Invoke-Native -File 'git' -Arguments @('ls-files','*.env','*/.env','.env','.env.*') -WorkDir $BackendDir
        if ($ls.Ok) { $tracked = @($ls.Out -split "`n" | Where-Object { $_ -and ($_ -notmatch '\.example$') }) }
        if ($tracked.Count -eq 0) {
            Add-Action -FixId 'gitignore-env' -Title 'Untrack committed .env' -Outcome 'SKIPPED' -Detail 'no tracked .env files.'
        } elseif ($DryRun) {
            Add-Action -FixId 'gitignore-env' -Title 'Untrack committed .env' -Outcome 'PLANNED' -Detail "would git rm --cached: $($tracked -join ', ')"
        } elseif (Confirm-Step "git rm --cached $($tracked.Count) tracked .env file(s) and add to .gitignore? (rotate any exposed secrets afterwards)") {
            foreach ($t in $tracked) { Invoke-Native -File 'git' -Arguments @('rm','--cached',$t) -WorkDir $BackendDir | Out-Null }
            $gi = Join-Path $BackendDir '.gitignore'
            if (Test-Path $gi) { $cur = Get-Content -Raw $gi } else { $cur = '' }
            if ($cur -notmatch '(?m)^\.env\*?\s*$') { Add-Content -Path $gi -Value "`n.env*`n!.env.example" }
            Add-Action -FixId 'gitignore-env' -Title 'Untrack committed .env' -Outcome 'APPLIED' -Detail "untracked: $($tracked -join ', '). ROTATE any exposed secrets."
        } else { Add-Action -FixId 'gitignore-env' -Title 'Untrack committed .env' -Outcome 'SKIPPED' -Detail 'declined.' }
    }
}

# ---- DESTRUCTIVE: purge locally-cached PHI audio ----
if (Has-Fix 'purge-local-uploads') {
    $uploads = Join-Path $BackendDir 'src\uploads'
    $media = @()
    if (Test-Path $uploads) { $media = @(Get-ChildItem -Path $uploads -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '(?i)\.(webm|wav|mp3|m4a|ogg|flac)$' }) }
    if ($media.Count -eq 0) {
        Add-Action -FixId 'purge-local-uploads' -Title 'Purge local PHI audio' -Outcome 'SKIPPED' -Detail 'no local audio files.'
    } elseif (-not $IncludeDestructive) {
        Add-Action -FixId 'purge-local-uploads' -Title 'Purge local PHI audio' -Outcome 'MANUAL' -Detail "$($media.Count) file(s) found. Re-run with -IncludeDestructive to delete (these are PHI; ensure they are safely in S3 first)."
    } elseif ($DryRun) {
        Add-Action -FixId 'purge-local-uploads' -Title 'Purge local PHI audio' -Outcome 'PLANNED' -Detail "would delete $($media.Count) audio file(s) under src/uploads."
    } elseif (Confirm-Step "DELETE $($media.Count) local audio file(s) from src/uploads? (confirm they are persisted in S3 first)") {
        $n = 0; foreach ($m in $media) { try { Remove-Item -Force $m.FullName; $n++ } catch {} }
        Add-Action -FixId 'purge-local-uploads' -Title 'Purge local PHI audio' -Outcome 'APPLIED' -Detail "deleted $n/$($media.Count) file(s)."
    } else { Add-Action -FixId 'purge-local-uploads' -Title 'Purge local PHI audio' -Outcome 'SKIPPED' -Detail 'declined.' }
}

# ---- DESTRUCTIVE: remove stale backup/temp directories ----
if (Has-Fix 'clean-stale-dirs') {
    $stale = @()
    $stale += @(Get-ChildItem -Path $BackendDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(backup-v\d+|temp-extract)' })
    $parent = Split-Path -Parent $BackendDir
    $stale += @(Get-ChildItem -Path $parent -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^temp-extract' })
    $stale = @($stale | Sort-Object FullName -Unique)
    if ($stale.Count -eq 0) {
        Add-Action -FixId 'clean-stale-dirs' -Title 'Remove stale backup/temp dirs' -Outcome 'SKIPPED' -Detail 'none present.'
    } elseif (-not $IncludeDestructive) {
        Add-Action -FixId 'clean-stale-dirs' -Title 'Remove stale backup/temp dirs' -Outcome 'MANUAL' -Detail "$($stale.Count) dir(s). Re-run with -IncludeDestructive to delete: $(@($stale | ForEach-Object { $_.Name }) -join ', ')"
    } elseif ($DryRun) {
        Add-Action -FixId 'clean-stale-dirs' -Title 'Remove stale backup/temp dirs' -Outcome 'PLANNED' -Detail "would delete $($stale.Count) dir(s)."
    } elseif (Confirm-Step "DELETE $($stale.Count) stale backup/temp director(ies)? (ensure changes are committed)") {
        $n = 0; foreach ($d in $stale) { try { Remove-Item -Recurse -Force $d.FullName; $n++ } catch {} }
        Add-Action -FixId 'clean-stale-dirs' -Title 'Remove stale backup/temp dirs' -Outcome 'APPLIED' -Detail "deleted $n/$($stale.Count) dir(s)."
    } else { Add-Action -FixId 'clean-stale-dirs' -Title 'Remove stale backup/temp dirs' -Outcome 'SKIPPED' -Detail 'declined.' }
}

# ---- AWS: set CloudWatch log retention on EB log groups ----
if (Has-Fix 'set-log-retention') {
    if (-not $awsReady) {
        Add-Action -FixId 'set-log-retention' -Title 'Set EB log retention' -Outcome 'SKIPPED' -Detail 'AWS not available.'
    } else {
        $lg = Invoke-Native -File 'aws' -Arguments @('logs','describe-log-groups','--log-group-name-prefix',$EbLogGroupPrefix,'--output','json')
        $groups = @()
        if ($lg.Ok) { try { $groups = @(($lg.Out | ConvertFrom-Json).logGroups) } catch {} }
        $needs = @($groups | Where-Object { (-not ($_.PSObject.Properties.Name -contains 'retentionInDays')) -or ([int]$_.retentionInDays -lt $RetentionDays) })
        if ($needs.Count -eq 0) {
            Add-Action -FixId 'set-log-retention' -Title 'Set EB log retention' -Outcome 'SKIPPED' -Detail "all EB log groups already retain >= $RetentionDays days."
        } elseif ($DryRun) {
            Add-Action -FixId 'set-log-retention' -Title 'Set EB log retention' -Outcome 'PLANNED' -Detail "would set $RetentionDays-day retention on $($needs.Count) group(s)."
        } elseif (Confirm-Step "Set $RetentionDays-day retention on $($needs.Count) EB log group(s)?") {
            $n = 0
            foreach ($g in $needs) {
                $r = Invoke-Native -File 'aws' -Arguments @('logs','put-retention-policy','--log-group-name',$g.logGroupName,'--retention-in-days',"$RetentionDays")
                if ($r.Ok) { $n++ }
            }
            Add-Action -FixId 'set-log-retention' -Title 'Set EB log retention' -Outcome 'APPLIED' -Detail "updated $n/$($needs.Count) group(s) to $RetentionDays days."
        } else { Add-Action -FixId 'set-log-retention' -Title 'Set EB log retention' -Outcome 'SKIPPED' -Detail 'declined.' }
    }
}

# ---- Delegated AWS security fixes (existing, proven scripts) ----
if (Has-Fix 'fix-s3-security') {
    if ($awsReady -or $DryRun) { Invoke-FixScript 'fix-s3-security.ps1' }
    else { Add-Action -FixId 'fix-s3-security' -Title 'Delegate to fix-s3-security.ps1' -Outcome 'SKIPPED' -Detail 'AWS not available.' }
}
if (Has-Fix 'fix-waf-logging') {
    if ($awsReady -or $DryRun) { Invoke-FixScript 'fix-waf-logging.ps1' }
    else { Add-Action -FixId 'fix-waf-logging' -Title 'Delegate to fix-waf-logging.ps1' -Outcome 'SKIPPED' -Detail 'AWS not available.' }
}
if (Has-Fix 'fix-ssm-ops') {
    if ($awsReady -or $DryRun) { Invoke-FixScript 'fix-ssm-ops-permissions.ps1' }
    else { Add-Action -FixId 'fix-ssm-ops' -Title 'Delegate to fix-ssm-ops-permissions.ps1' -Outcome 'SKIPPED' -Detail 'AWS not available.' }
}

if ($wantedFixes.Count -eq 0) {
    Write-Step 'No automated fixes were queued (audit found nothing auto-fixable, or none matched the catalog).'
}

# =============================================================================
# MANUAL STEPS (findings with no automated fix)
# =============================================================================
Write-Phase 'MANUAL STEPS (action required - no automated fix)'

if ($manualFindings.Count -eq 0) {
    Write-Ok 'No manual-only findings.'
} else {
    $idx = 0
    foreach ($f in ($manualFindings | Sort-Object @{ Expression = { @{ 'CRITICAL'=0;'HIGH'=1;'MEDIUM'=2;'LOW'=3;''=4 }[$_.severity] } })) {
        $idx++
        $col = switch ($f.severity) { 'CRITICAL' { 'Red' } 'HIGH' { 'Red' } 'MEDIUM' { 'Yellow' } default { 'DarkYellow' } }
        Write-Host ''
        Write-Host "  $idx. [$($f.severity)] $($f.section) / $($f.name)" -ForegroundColor $col
        if ($f.detail)      { Write-Diag "what : $($f.detail)" }
        if ($f.rootCause)   { Write-Diag "why  : $($f.rootCause)" }
        if ($f.impact)      { Write-Diag "risk : $($f.impact)" }
        if ($f.remediation) { Write-Host "      fix  : $($f.remediation)" -ForegroundColor Gray }
        if ($f.manual)      { Write-Host "      step : $($f.manual)" -ForegroundColor Gray }
        Add-Action -FixId ($f.fixId) -Title "$($f.section) / $($f.name)" -Outcome 'MANUAL' -Detail $f.remediation
    }
}

# =============================================================================
# SUMMARY + RESULT JSON
# =============================================================================
Write-Phase 'SUMMARY'

$applied = @($script:Actions | Where-Object { $_.Outcome -eq 'APPLIED' }).Count
$planned = @($script:Actions | Where-Object { $_.Outcome -eq 'PLANNED' }).Count
$skipped = @($script:Actions | Where-Object { $_.Outcome -eq 'SKIPPED' }).Count
$failed  = @($script:Actions | Where-Object { $_.Outcome -eq 'FAILED' }).Count
$manual  = @($script:Actions | Where-Object { $_.Outcome -eq 'MANUAL' }).Count

Write-Host ''
Write-Host "  Applied=$applied  Planned=$planned  Skipped=$skipped  Failed=$failed  Manual=$manual" -ForegroundColor Gray

$summary = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    mode        = if ($DryRun) { 'dry-run' } else { 'live' }
    counts      = [ordered]@{ applied = $applied; planned = $planned; skipped = $skipped; failed = $failed; manual = $manual }
    actions     = @($script:Actions | ForEach-Object { [ordered]@{ fixId = $_.FixId; title = $_.Title; outcome = $_.Outcome; detail = $_.Detail; at = $_.At } })
}
[System.IO.File]::WriteAllText($ResultJson, ($summary | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
Write-Step "Results -> $ResultJson"

Write-Host ''
Write-Host ('=' * 78) -ForegroundColor $(if ($failed -gt 0) { 'Yellow' } else { 'Green' })
if ($DryRun) {
    Write-Host '  DRY-RUN COMPLETE: all fixes rehearsed; nothing changed. Re-run with -Live to apply.' -ForegroundColor DarkGray
} else {
    Write-Host "  FIXES COMPLETE: $applied applied, $failed failed, $manual manual step(s) remaining." -ForegroundColor $(if ($failed -gt 0) { 'Yellow' } else { 'Green' })
}
Write-Host ('=' * 78) -ForegroundColor $(if ($failed -gt 0) { 'Yellow' } else { 'Green' })
Write-Host '  Next: powershell -File scripts/verify-production-100-percent.ps1 -Live' -ForegroundColor Gray
Write-Host ''

if ($failed -gt 0) { exit 1 }
exit 0
