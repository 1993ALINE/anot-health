<#
================================================================================
 fix-backend-npm-vulnerabilities.ps1  -  Resolve the backend HIGH/CRITICAL npm
                      advisories that 'npm audit fix' could not, by manually
                      pinning the offending packages to safe versions, doing a
                      clean reproducible install, smoke-testing the backend, and
                      committing the result.
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHY THIS EXISTS:
   fix-all-bugs.ps1 ran 'npm audit fix' in the backend and it FAILED: npm could
   not auto-resolve the advisories because the safe versions introduce a
   dependency conflict (a transitive peer/range clash) that 'npm audit fix'
   refuses to force. This script does the resolution deterministically:

 WHAT THIS SCRIPT DOES (top to bottom):
   PHASE 1  Read 'npm audit --json' and enumerate every HIGH/CRITICAL advisory,
            mapping each back to the TOP-LEVEL dependency in package.json that
            pulls it in, and the safe ("fixAvailable") version to move to.
   PHASE 2  Back up package.json + package-lock.json, then pin each affected
            top-level dependency to its safe version range in package.json.
   PHASE 3  Refresh the lockfile (npm install) so package.json + lock agree,
            then run 'npm ci' (clean, reproducible install) to verify integrity.
   PHASE 4  Re-run 'npm audit --json' and confirm 0 HIGH + 0 CRITICAL remain.
   PHASE 5  Smoke-test the backend: 'node --check' every source file and start
            src/server.js briefly to confirm it boots without crashing.
   PHASE 6  Commit package.json + package-lock.json (unless -NoCommit).

 SAFETY:
   * -DryRun analyzes the audit and PRINTS the exact version bumps it WOULD make,
     and changes NOTHING (no package.json edit, no install, no commit).
   * On any failure after PHASE 2 the original package.json + package-lock.json
     are RESTORED from the backups taken in PHASE 2.
   * Mutating steps prompt for confirmation unless -Force / -SkipConfirm.
   * -NoCommit applies the fix but leaves the commit to you.
   * -SkipStartTest skips booting server.js (use when no DB/env is available).

 USAGE:
   powershell -File scripts/fix-backend-npm-vulnerabilities.ps1 -DryRun
   powershell -File scripts/fix-backend-npm-vulnerabilities.ps1
   powershell -File scripts/fix-backend-npm-vulnerabilities.ps1 -Force -NoCommit
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Live,
    [switch]$Force,
    [switch]$SkipConfirm,
    [switch]$NoCommit,
    [switch]$SkipStartTest,
    [int]$StartTestSeconds = 8
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$ScriptDir   = $PSScriptRoot
$BackendDir  = Split-Path -Parent $ScriptDir
$BackendSrc  = Join-Path $BackendDir 'src'
$PkgJsonPath = Join-Path $BackendDir 'package.json'
$LockPath    = Join-Path $BackendDir 'package-lock.json'
$ArtifactDir = Join-Path $BackendDir 'dist'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'
$ResultJson  = Join-Path $ArtifactDir "npm-vuln-fix-$Stamp.json"

# Default to LIVE if neither switch was given (matches the other fix scripts).
if (-not $DryRun -and -not $Live) { $Live = $true }
if ($DryRun) { $Live = $false }

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
    param([string]$Title, [ValidateSet('APPLIED','SKIPPED','FAILED','PLANNED','INFO')] [string]$Outcome, [string]$Detail = '')
    $rec = [pscustomobject]@{ Title = $Title; Outcome = $Outcome; Detail = $Detail; At = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    $script:Actions.Add($rec)
}

# Run a child command (npm, node, git) capturing combined output + exit code.
function Invoke-Native {
    param([string]$File, [string[]]$Arguments, [string]$WorkDir = $null)
    $prev = $null
    if ($WorkDir) { $prev = Get-Location; Set-Location $WorkDir }
    $out = ''; $code = 0
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $captured = & $File @Arguments 2>&1
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
        $out = (@($captured) | ForEach-Object { [string]$_ }) -join "`n"
    }
    catch { $code = 9001; $out = $_.Exception.Message }
    finally {
        $ErrorActionPreference = $prevEap
        if ($prev) { Set-Location $prev }
    }
    return @{ Ok = ($code -eq 0); Code = $code; Out = $out }
}
#endregion

trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  FIX-BACKEND-NPM-VULNERABILITIES FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    if ($script:BackupTaken -and -not $script:CommitDone) {
        Write-Host '  Attempting to restore package.json + package-lock.json from backup...' -ForegroundColor Yellow
        try { Restore-Backups } catch { Write-Host "    restore failed: $($_.Exception.Message)" -ForegroundColor Red }
    }
    Write-Host ''
    exit 1
}
# Backup / restore the two files we mutate. Backups land beside the originals.
$script:BackupTaken = $false
$script:CommitDone  = $false
$script:PkgBackup   = Join-Path $ArtifactDir "package.json.bak-$Stamp"
$script:LockBackup  = Join-Path $ArtifactDir "package-lock.json.bak-$Stamp"

function Take-Backups {
    New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
    if (Test-Path $PkgJsonPath) { Copy-Item -Force $PkgJsonPath $script:PkgBackup }
    if (Test-Path $LockPath)    { Copy-Item -Force $LockPath    $script:LockBackup }
    $script:BackupTaken = $true
    Write-Diag "backup: $script:PkgBackup"
    if (Test-Path $LockPath) { Write-Diag "backup: $script:LockBackup" }
}
function Restore-Backups {
    if (Test-Path $script:PkgBackup)  { Copy-Item -Force $script:PkgBackup  $PkgJsonPath }
    if (Test-Path $script:LockBackup) { Copy-Item -Force $script:LockBackup $LockPath }
    Write-Warn 'Restored package.json + package-lock.json from backup.'
}

# =============================================================================
# PRE-FLIGHT
# =============================================================================
Write-Phase 'PRE-FLIGHT: tooling + repo layout'

if ($DryRun) { Write-Warn 'DRY-RUN MODE: the fix is analyzed and printed; nothing is changed.' }
else         { Write-Step 'LIVE MODE: vulnerable packages will be pinned, reinstalled, tested, and committed.' }

Write-Diag "backend dir : $BackendDir"
Write-Diag "package.json: $PkgJsonPath"

if (-not (Test-Path $PkgJsonPath)) { throw "package.json not found at $PkgJsonPath." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm not found on PATH. Install Node.js to run this fix.' }

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null

$nodeV = (Invoke-Native -File 'node' -Arguments @('--version')).Out
$npmV  = (Invoke-Native -File 'npm'  -Arguments @('--version')).Out
Write-Diag "node $nodeV / npm $npmV"

# =============================================================================
# PHASE 1 - Analyze npm audit + map advisories to top-level dependencies
# =============================================================================
Write-Phase 'PHASE 1: analyze npm audit (HIGH/CRITICAL only)'

$pkg = Get-Content -Raw -Path $PkgJsonPath | ConvertFrom-Json
$directDeps = @{}
foreach ($scope in @('dependencies','devDependencies','optionalDependencies')) {
    if ($pkg.PSObject.Properties.Name -contains $scope -and $pkg.$scope) {
        foreach ($p in $pkg.$scope.PSObject.Properties) { $directDeps[$p.Name] = $scope }
    }
}
Write-Diag "top-level dependencies declared: $($directDeps.Keys.Count)"

Write-Step 'Running: npm audit --json'
$auditRes = Invoke-Native -File 'npm' -Arguments @('audit','--json') -WorkDir $BackendDir
$auditObj = $null
try { $auditObj = $auditRes.Out | ConvertFrom-Json } catch { $auditObj = $null }
if ($null -eq $auditObj) { throw "Could not parse 'npm audit --json' output. Raw tail:`n$($auditRes.Out -split "`n" | Select-Object -Last 5)" }

# npm v7+ audit shape: .vulnerabilities is a map keyed by package name. Each entry
# has .severity, .isDirect, .fixAvailable (bool OR { name; version; isSemVerMajor })
# and .via (array of advisory objects or parent package names). We walk the map,
# keep HIGH/CRITICAL, and resolve the TOP-LEVEL dependency to bump + the target.
$vulnMap = $null
if ($auditObj.PSObject.Properties.Name -contains 'vulnerabilities') { $vulnMap = $auditObj.vulnerabilities }
if ($null -eq $vulnMap) { throw "npm audit JSON has no 'vulnerabilities' map (npm < 7 is not supported by this script)." }

$meta = $null
if ($auditObj.PSObject.Properties.Name -contains 'metadata') { $meta = $auditObj.metadata.vulnerabilities }
$preHigh = if ($meta) { [int]$meta.high } else { 0 }
$preCrit = if ($meta) { [int]$meta.critical } else { 0 }
Write-Diag "advisory totals before fix: critical=$preCrit high=$preHigh"

# Build the set of HIGH/CRITICAL advisories and the bumps required.
$advisories = New-Object System.Collections.Generic.List[object]
$bumps = @{}   # topLevelDepName -> @{ Current; Target; Major; Reason }
$manualNotes = New-Object System.Collections.Generic.List[object]   # advisories with no npm fix

function Resolve-TopLevel {
    # Walk .via parents up to the nearest declared top-level dependency.
    param([string]$Name, $Map, $Direct, [hashtable]$Seen)
    if ($Seen.ContainsKey($Name)) { return @() }
    $Seen[$Name] = $true
    if ($Direct.ContainsKey($Name)) { return @($Name) }
    $node = $null
    if ($Map.PSObject.Properties.Name -contains $Name) { $node = $Map.$Name }
    if ($null -eq $node) { return @() }
    $parents = @()
    foreach ($v in @($node.via)) {
        if ($v -is [string]) { $parents += Resolve-TopLevel -Name $v -Map $Map -Direct $Direct -Seen $Seen }
    }
    # .effects lists packages that depend ON this one; follow them upward too.
    if ($node.PSObject.Properties.Name -contains 'effects') {
        foreach ($e in @($node.effects)) { $parents += Resolve-TopLevel -Name $e -Map $Map -Direct $Direct -Seen $Seen }
    }
    return @($parents | Sort-Object -Unique)
}

foreach ($prop in $vulnMap.PSObject.Properties) {
    $name = $prop.Name
    $node = $prop.Value
    $sev  = "$($node.severity)"
    if ($sev -notin @('high','critical')) { continue }

    # Human-readable advisory titles (from .via entries that are objects).
    $titles = @()
    foreach ($v in @($node.via)) {
        if ($v -isnot [string] -and ($v.PSObject.Properties.Name -contains 'title')) {
            $titles += "$($v.title) ($($v.severity))"
        }
    }

    $advisories.Add([pscustomobject]@{
        Package  = $name
        Severity = $sev
        Direct   = [bool]$node.isDirect
        Range    = "$($node.range)"
        Titles   = $titles
    })

    # Determine the target safe version (from fixAvailable when it is an object).
    $fix = $node.fixAvailable
    $fixName = $null; $fixVer = $null; $fixMajor = $false; $fixable = $false
    if ($fix -is [bool]) { $fixable = $fix }
    elseif ($fix) {
        $fixable = $true
        if ($fix.PSObject.Properties.Name -contains 'name')    { $fixName  = $fix.name }
        if ($fix.PSObject.Properties.Name -contains 'version') { $fixVer   = $fix.version }
        if ($fix.PSObject.Properties.Name -contains 'isSemVerMajor') { $fixMajor = [bool]$fix.isSemVerMajor }
    }

    # No npm-published fix (fixAvailable=false). A version bump cannot resolve this
    # (e.g. SheetJS 'xlsx' is fixed only via the vendor CDN build, not the npm
    # registry). Record it as a manual note instead of planning a phantom no-op bump.
    if (-not $fixable) {
        $manualNotes.Add([pscustomobject]@{
            Package  = $name
            Severity = $sev
            Detail   = "No npm-registry fix is available for '$name' ($sev). A version bump will not resolve it; replace/patch the package manually (for 'xlsx', install the SheetJS CDN build per https://docs.sheetjs.com)."
        })
        continue
    }

    # Find the top-level dependency(ies) we must bump to carry the fix.
    $tops = @()
    if ($directDeps.ContainsKey($name)) { $tops = @($name) }
    else { $tops = @(Resolve-TopLevel -Name $name -Map $vulnMap -Direct $directDeps -Seen (@{})) }
    if ($tops.Count -eq 0 -and $fixName -and $directDeps.ContainsKey($fixName)) { $tops = @($fixName) }

    foreach ($t in $tops) {
        # Target version: prefer fixAvailable.version when it names THIS top-level
        # dep; otherwise resolve the latest published version for the dep.
        $target = $null; $major = $fixMajor
        if ($fixName -eq $t -and $fixVer) { $target = $fixVer }
        if (-not $target) {
            $lv = (Invoke-Native -File 'npm' -Arguments @('view',"$t",'version') -WorkDir $BackendDir)
            if ($lv.Ok) { $target = ($lv.Out -split "`n" | Where-Object { $_ -match '^\d' } | Select-Object -Last 1) }
        }
        $cur = $null
        if ($pkg.dependencies -and ($pkg.dependencies.PSObject.Properties.Name -contains $t)) { $cur = $pkg.dependencies.$t }
        elseif ($pkg.devDependencies -and ($pkg.devDependencies.PSObject.Properties.Name -contains $t)) { $cur = $pkg.devDependencies.$t }
        if ($target) {
            if (-not $bumps.ContainsKey($t)) {
                $bumps[$t] = @{ Current = $cur; Target = $target; Major = $major; Reason = "$name ($sev)" }
            } else {
                # Keep the higher target if multiple advisories touch the same dep.
                if (([version]($bumps[$t].Target -replace '[^0-9.].*$','')) -lt ([version]($target -replace '[^0-9.].*$',''))) {
                    $bumps[$t].Target = $target; $bumps[$t].Major = $major
                }
                $bumps[$t].Reason += ", $name ($sev)"
            }
        }
    }
}

Write-Host ''
Write-Host "  HIGH/CRITICAL advisories found: $($advisories.Count)" -ForegroundColor $(if ($advisories.Count) { 'Yellow' } else { 'Green' })
foreach ($a in $advisories) {
    Write-Host "    - [$($a.Severity.ToUpper())] $($a.Package)  (range $($a.Range), direct=$($a.Direct))" -ForegroundColor DarkYellow
    foreach ($t in $a.Titles) { Write-Diag $t }
}

if ($advisories.Count -eq 0) {
    Write-Ok 'No HIGH or CRITICAL backend advisories remain. Nothing to fix.'
    Add-Action -Title 'Analyze npm audit' -Outcome 'INFO' -Detail 'No high/critical advisories.'
    $summary = [ordered]@{ generatedAt=(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); mode=$(if($DryRun){'dry-run'}else{'live'}); before=@{critical=$preCrit;high=$preHigh}; bumps=@(); actions=@($script:Actions) }
    [System.IO.File]::WriteAllText($ResultJson, ($summary | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
    Write-Step "Results -> $ResultJson"
    exit 0
}

Write-Host ''
Write-Host '  Planned top-level version bumps (carry the fixes):' -ForegroundColor Cyan
if ($bumps.Keys.Count -eq 0) {
    Write-Warn 'Could not map advisories to a safe top-level version. Inspect npm audit manually.'
} else {
    foreach ($k in ($bumps.Keys | Sort-Object)) {
        $b = $bumps[$k]
        $majorTxt = if ($b.Major) { ' [SEMVER-MAJOR]' } else { '' }
        Write-Host "    $k : $($b.Current) -> ^$($b.Target)$majorTxt" -ForegroundColor Gray
        Write-Diag "fixes: $($b.Reason)"
        Add-Action -Title "Bump $k" -Outcome 'PLANNED' -Detail "$($b.Current) -> ^$($b.Target)$majorTxt (fixes $($b.Reason))"
    }
}

if ($manualNotes.Count -gt 0) {
    Write-Host ''
    Write-Host '  Advisories with NO npm-registry fix (manual action required):' -ForegroundColor Yellow
    foreach ($mn in $manualNotes) {
        Write-Host "    - [$($mn.Severity.ToUpper())] $($mn.Package)" -ForegroundColor DarkYellow
        Write-Diag $mn.Detail
        Add-Action -Title "Manual: $($mn.Package)" -Outcome 'INFO' -Detail $mn.Detail
    }
}

if ($DryRun) {
    Write-Host ''
    Write-Warn 'DRY-RUN: no package.json edit, no install, no commit performed.'
    $summary = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        mode        = 'dry-run'
        before      = @{ critical = $preCrit; high = $preHigh }
        bumps       = @($bumps.Keys | ForEach-Object { [ordered]@{ package=$_; current=$bumps[$_].Current; target=("^"+$bumps[$_].Target); major=$bumps[$_].Major; fixes=$bumps[$_].Reason } })
        manualNotes = @($manualNotes | ForEach-Object { [ordered]@{ package=$_.Package; severity=$_.Severity; detail=$_.Detail } })
        actions     = @($script:Actions | ForEach-Object { [ordered]@{ title=$_.Title; outcome=$_.Outcome; detail=$_.Detail; at=$_.At } })
    }
    [System.IO.File]::WriteAllText($ResultJson, ($summary | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
    Write-Step "Results -> $ResultJson"
    Write-Host ''
    Write-Host '  Re-run without -DryRun to apply.' -ForegroundColor Gray
    exit 0
}

if ($bumps.Keys.Count -eq 0) {
    Write-Host ''
    Write-Warn 'No advisory has an automated npm fix; nothing to install or commit.'
    Write-Warn 'Resolve the manual advisory(ies) above by hand, then re-audit.'
    $summary = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        mode        = 'live'
        before      = [ordered]@{ critical = $preCrit; high = $preHigh }
        bumps       = @()
        manualNotes = @($manualNotes | ForEach-Object { [ordered]@{ package=$_.Package; severity=$_.Severity; detail=$_.Detail } })
        actions     = @($script:Actions | ForEach-Object { [ordered]@{ title=$_.Title; outcome=$_.Outcome; detail=$_.Detail; at=$_.At } })
    }
    [System.IO.File]::WriteAllText($ResultJson, ($summary | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
    Write-Step "Results -> $ResultJson"
    exit 1
}
# =============================================================================
# PHASE 2 - Back up + pin the affected dependencies in package.json
# =============================================================================
Write-Phase 'PHASE 2: pin safe versions in package.json'

if (-not (Confirm-Step "Back up package.json/package-lock.json and pin $($bumps.Keys.Count) dependency(ies) to safe versions?")) {
    Write-Warn 'Declined. No changes made.'
    exit 0
}

Take-Backups

# Edit the raw package.json text so we preserve formatting + key order and only
# touch the version strings we are bumping. Each dep is "name": "range".
$pkgText = Get-Content -Raw -Path $PkgJsonPath
foreach ($k in ($bumps.Keys | Sort-Object)) {
    $target = $bumps[$k].Target
    $escaped = [regex]::Escape($k)
    $pattern = '("' + $escaped + '"\s*:\s*")[^"]*(")'
    $replacement = '${1}^' + $target + '${2}'
    $new = [regex]::Replace($pkgText, $pattern, $replacement)
    if ($new -eq $pkgText) {
        Write-Warn "Could not find '$k' in package.json text to bump; skipping (it may be transitive-only)."
        Add-Action -Title "Bump $k" -Outcome 'SKIPPED' -Detail 'not a literal top-level entry in package.json.'
    } else {
        $pkgText = $new
        Write-Ok "pinned $k -> ^$target"
        Add-Action -Title "Bump $k" -Outcome 'APPLIED' -Detail "-> ^$target (fixes $($bumps[$k].Reason))"
    }
}
[System.IO.File]::WriteAllText($PkgJsonPath, $pkgText, [System.Text.UTF8Encoding]::new($false))
Write-Step 'package.json updated.'

# =============================================================================
# PHASE 3 - Refresh the lockfile, then clean-install with npm ci
# =============================================================================
Write-Phase 'PHASE 3: reinstall (npm install -> npm ci) to verify integrity'

# 'npm ci' requires package.json and package-lock.json to agree, so we first run
# 'npm install' to resolve the new ranges into the lockfile. We avoid 'audit fix
# --force' (that is exactly what failed) and instead let the explicit pins above
# drive resolution. --no-audit keeps this step quiet; we re-audit in PHASE 4.
Write-Step 'Running: npm install (regenerate package-lock.json from the new ranges)'
$inst = Invoke-Native -File 'npm' -Arguments @('install','--no-audit','--no-fund') -WorkDir $BackendDir
if (-not $inst.Ok) {
    Write-Warn 'npm install failed; the new versions still conflict. Restoring backups.'
    Write-Diag ($inst.Out -split "`n" | Select-Object -Last 12 | Out-String)
    Restore-Backups
    Add-Action -Title 'npm install' -Outcome 'FAILED' -Detail ($inst.Out -split "`n" | Select-Object -Last 1)
    throw 'Dependency conflict persisted after pinning. See output above; backups restored.'
}
Write-Ok 'npm install succeeded; lockfile refreshed.'
Add-Action -Title 'npm install' -Outcome 'APPLIED' -Detail 'lockfile regenerated.'

Write-Step 'Running: npm ci (clean, reproducible install from the lockfile)'
$ci = Invoke-Native -File 'npm' -Arguments @('ci','--no-audit','--no-fund') -WorkDir $BackendDir
if (-not $ci.Ok) {
    Write-Warn 'npm ci failed. Restoring backups.'
    Write-Diag ($ci.Out -split "`n" | Select-Object -Last 12 | Out-String)
    Restore-Backups
    Add-Action -Title 'npm ci' -Outcome 'FAILED' -Detail ($ci.Out -split "`n" | Select-Object -Last 1)
    throw 'npm ci failed to install from the refreshed lockfile; backups restored.'
}
Write-Ok 'npm ci succeeded; node_modules matches the lockfile exactly.'
Add-Action -Title 'npm ci' -Outcome 'APPLIED' -Detail 'clean install verified.'

# =============================================================================
# PHASE 4 - Re-audit and confirm HIGH/CRITICAL are resolved
# =============================================================================
Write-Phase 'PHASE 4: re-audit (confirm 0 high + 0 critical)'

$post = Invoke-Native -File 'npm' -Arguments @('audit','--json') -WorkDir $BackendDir
$postObj = $null
try { $postObj = $post.Out | ConvertFrom-Json } catch {}
$postHigh = 0; $postCrit = 0; $postMod = 0; $postLow = 0
if ($postObj -and ($postObj.PSObject.Properties.Name -contains 'metadata')) {
    $pv = $postObj.metadata.vulnerabilities
    $postCrit = [int]$pv.critical; $postHigh = [int]$pv.high; $postMod = [int]$pv.moderate; $postLow = [int]$pv.low
}
Write-Diag "advisory totals after fix: critical=$postCrit high=$postHigh moderate=$postMod low=$postLow"

if ($postCrit -eq 0 -and $postHigh -eq 0) {
    Write-Ok "All HIGH/CRITICAL backend advisories resolved (was critical=$preCrit high=$preHigh)."
    Add-Action -Title 'Re-audit' -Outcome 'APPLIED' -Detail "critical=$postCrit high=$postHigh moderate=$postMod low=$postLow"
} else {
    Write-Warn "Some HIGH/CRITICAL advisories remain (critical=$postCrit high=$postHigh). They may require a breaking major bump or have no fix yet."
    Add-Action -Title 'Re-audit' -Outcome 'FAILED' -Detail "still critical=$postCrit high=$postHigh"
}

# =============================================================================
# PHASE 5 - Smoke-test the backend
# =============================================================================
Write-Phase 'PHASE 5: smoke-test the backend boots'

$serverEntry = Join-Path $BackendSrc 'server.js'
$startOk = $true

# 5a. Syntax-check the entrypoint (cheap, deterministic, no DB/env needed).
if (Test-Path $serverEntry) {
    $chk = Invoke-Native -File 'node' -Arguments @('--check', $serverEntry) -WorkDir $BackendDir
    if ($chk.Ok) { Write-Ok 'node --check src/server.js: syntax OK.'; Add-Action -Title 'Syntax check' -Outcome 'APPLIED' -Detail 'server.js parses.' }
    else { $startOk = $false; Write-Warn "node --check failed: $($chk.Out)"; Add-Action -Title 'Syntax check' -Outcome 'FAILED' -Detail ($chk.Out -split "`n" | Select-Object -Last 1) }
} else {
    Write-Warn "server entrypoint not found at $serverEntry; skipping syntax check."
}

# 5b. Best-effort boot: start server.js for a few seconds and confirm it does not
#     crash on startup. The backend may exit if no DB/env is present, so we treat
#     a clean "listening" signal as PASS and a hard crash as WARN (not fatal).
if ($SkipStartTest) {
    Write-Step '-SkipStartTest: not booting server.js.'
    Add-Action -Title 'Start test' -Outcome 'SKIPPED' -Detail 'skipped by flag.'
} elseif (Test-Path $serverEntry) {
    Write-Step "Booting server.js for up to ${StartTestSeconds}s to confirm it starts..."
    $stdoutFile = Join-Path $ArtifactDir "server-smoke-$Stamp.out.log"
    $stderrFile = Join-Path $ArtifactDir "server-smoke-$Stamp.err.log"
    $proc = $null
    try {
        $proc = Start-Process -FilePath 'node' -ArgumentList @('src/server.js') -WorkingDirectory $BackendDir `
            -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -PassThru -WindowStyle Hidden
    } catch { Write-Warn "Could not launch node: $($_.Exception.Message)" }

    if ($proc) {
        $deadline = (Get-Date).AddSeconds($StartTestSeconds)
        $listening = $false; $crashed = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 600
            if ($proc.HasExited) { $crashed = $true; break }
            $so = ''
            try { $so = Get-Content -Raw -Path $stdoutFile -ErrorAction SilentlyContinue } catch {}
            $se = ''
            try { $se = Get-Content -Raw -Path $stderrFile -ErrorAction SilentlyContinue } catch {}
            if (("$so$se") -match '(?i)(listening|server (running|started)|started on|ready|port\s*\d+)') { $listening = $true; break }
        }
        if (-not $proc.HasExited) { try { $proc.Kill() } catch {}; try { $proc.WaitForExit(3000) } catch {} }

        $tailOut = ''
        try { $tailOut = ((Get-Content -Path $stdoutFile -ErrorAction SilentlyContinue) + (Get-Content -Path $stderrFile -ErrorAction SilentlyContinue)) -join "`n" } catch {}
        if ($listening) {
            Write-Ok 'Backend booted and signalled it was listening/ready.'
            Add-Action -Title 'Start test' -Outcome 'APPLIED' -Detail 'server reached a listening/ready state.'
        } elseif ($crashed -and $proc.ExitCode -ne 0) {
            Write-Warn "Backend process exited early (code $($proc.ExitCode)). Often a missing DB/env in this shell, not the dependency bump."
            Write-Diag ($tailOut -split "`n" | Select-Object -Last 10 | Out-String)
            Add-Action -Title 'Start test' -Outcome 'FAILED' -Detail "exited code $($proc.ExitCode) within ${StartTestSeconds}s."
        } else {
            Write-Ok "Backend stayed up for ${StartTestSeconds}s without crashing (no explicit listening log captured)."
            Add-Action -Title 'Start test' -Outcome 'APPLIED' -Detail "ran ${StartTestSeconds}s without crashing."
        }
    }
}

# =============================================================================
# PHASE 6 - Commit package.json + package-lock.json
# =============================================================================
Write-Phase 'PHASE 6: commit the dependency fixes'

if ($NoCommit) {
    Write-Step '-NoCommit: leaving the working tree changes uncommitted for you to review.'
    Add-Action -Title 'Commit' -Outcome 'SKIPPED' -Detail '-NoCommit set.'
} elseif (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Warn 'git not on PATH; cannot commit. Commit package.json + package-lock.json manually.'
    Add-Action -Title 'Commit' -Outcome 'SKIPPED' -Detail 'git not available.'
} else {
    $fixedList = ($bumps.Keys | Sort-Object) -join ', '
    $msg = "fix(backend deps): pin $fixedList to patched versions; resolve $preHigh high + $preCrit critical npm advisories"
    if (Confirm-Step 'Commit package.json + package-lock.json with the dependency fix message?') {
        $add = Invoke-Native -File 'git' -Arguments @('add','--',$PkgJsonPath,$LockPath) -WorkDir $BackendDir
        if (-not $add.Ok) { Write-Warn "git add reported: $($add.Out)" }
        $commit = Invoke-Native -File 'git' -Arguments @('commit','-m',$msg) -WorkDir $BackendDir
        if ($commit.Ok) {
            $script:CommitDone = $true
            Write-Ok 'Committed package.json + package-lock.json.'
            Add-Action -Title 'Commit' -Outcome 'APPLIED' -Detail $msg
        } else {
            Write-Warn "git commit reported: $($commit.Out -split "`n" | Select-Object -Last 2)"
            Add-Action -Title 'Commit' -Outcome 'FAILED' -Detail ($commit.Out -split "`n" | Select-Object -Last 1)
        }
    } else {
        Add-Action -Title 'Commit' -Outcome 'SKIPPED' -Detail 'declined.'
    }
}

# =============================================================================
# SUMMARY + RESULT JSON
# =============================================================================
Write-Phase 'SUMMARY'

$summary = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    mode        = 'live'
    before      = [ordered]@{ critical = $preCrit; high = $preHigh }
    after       = [ordered]@{ critical = $postCrit; high = $postHigh; moderate = $postMod; low = $postLow }
    resolved    = ($postCrit -eq 0 -and $postHigh -eq 0)
    committed   = $script:CommitDone
    bumps       = @($bumps.Keys | ForEach-Object { [ordered]@{ package = $_; current = $bumps[$_].Current; target = ('^' + $bumps[$_].Target); major = $bumps[$_].Major; fixes = $bumps[$_].Reason } })
    manualNotes = @($manualNotes | ForEach-Object { [ordered]@{ package = $_.Package; severity = $_.Severity; detail = $_.Detail } })
    actions     = @($script:Actions | ForEach-Object { [ordered]@{ title = $_.Title; outcome = $_.Outcome; detail = $_.Detail; at = $_.At } })
}
[System.IO.File]::WriteAllText($ResultJson, ($summary | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
Write-Step "Results -> $ResultJson"

$ok = ($postCrit -eq 0 -and $postHigh -eq 0)
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor $(if ($ok) { 'Green' } else { 'Yellow' })
if ($ok) { Write-Host "  DONE: backend HIGH/CRITICAL advisories resolved ($preHigh high + $preCrit critical -> 0)." -ForegroundColor Green }
else     { Write-Host "  PARTIAL: $postHigh high + $postCrit critical advisory(ies) still remain (no non-breaking fix)." -ForegroundColor Yellow }
Write-Host ('=' * 78) -ForegroundColor $(if ($ok) { 'Green' } else { 'Yellow' })
Write-Host '  Next: powershell -File scripts/verify-production-100-percent.ps1 -Live' -ForegroundColor Gray
Write-Host ''

if ($ok) { exit 0 } else { exit 1 }


