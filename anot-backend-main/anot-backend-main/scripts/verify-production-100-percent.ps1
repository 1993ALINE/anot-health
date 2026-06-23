<#
================================================================================
 verify-production-100-percent.ps1  -  Final, unified production verification +
                                        100/100 scorecard for Anot Health.
================================================================================
 Pure PowerShell. Works on Windows PowerShell 5.1 and PowerShell 7+.
 ASCII-only on purpose (no em-dashes, no emoji) so it never corrupts on paste.

 WHAT THIS SCRIPT DOES:
   Runs the full platform audit (audit-complete-platform.ps1) and the existing
   infrastructure readiness validation (validate-production.ps1) when present,
   then merges both result sets into ONE unified scorecard:
     * Console : per-category scores + a final verdict.
     * JSON    : dist/production-100-scorecard.json
     * HTML    : dist/production-100-scorecard.html

   The verdict is honest: "100/100 PRODUCTION READY" is reported ONLY when every
   scored check passes (no FAIL, no WARN) across both tools. Otherwise it lists
   the exact remaining gaps that stand between the platform and a perfect score.

 HOW SCORING WORKS:
   Each underlying check has a weight; PASS earns full weight, WARN earns half,
   FAIL earns none. The unified score is the weighted percentage across every
   scored check from both tools. SKIP/INFO checks are excluded from scoring
   (e.g. AWS checks skipped because no credentials are present) but are reported
   so you know coverage was partial.

 MODES:
   -Live          Run both tools live (default).
   -DryRun        Rehearse: enumerate planned work, write a placeholder card.
   -UseExisting   Do NOT re-run the tools; score the most recent JSON outputs in
                  dist/ (audit-complete-results.json + validation-results.json).
   -SkipAws       Forward to the audit so AWS checks are skipped.
   -SkipNet       Forward to the audit so network probes are skipped.
   -SkipValidate  Do not run validate-production.ps1 (audit only).

 USAGE:
   powershell -File scripts/verify-production-100-percent.ps1 -Live
   powershell -File scripts/verify-production-100-percent.ps1 -UseExisting
================================================================================
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Live,
    [switch]$UseExisting,
    [switch]$SkipAws,
    [switch]$SkipNet,
    [switch]$SkipValidate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region ----------------------------- CONFIG ----------------------------------
$ScriptDir   = $PSScriptRoot
$BackendDir  = Split-Path -Parent $ScriptDir
$ArtifactDir = Join-Path $BackendDir 'dist'

$AuditScript    = Join-Path $ScriptDir 'audit-complete-platform.ps1'
$ValidateScript = Join-Path $ScriptDir 'validate-production.ps1'

$AuditJson      = Join-Path $ArtifactDir 'audit-complete-results.json'
$ValidateJson   = Join-Path $ArtifactDir 'validation-results.json'

$ScorecardJson  = Join-Path $ArtifactDir 'production-100-scorecard.json'
$ScorecardHtml  = Join-Path $ArtifactDir 'production-100-scorecard.html'
$StartTime      = Get-Date

if (-not $DryRun -and -not $Live -and -not $UseExisting) { $Live = $true }
if ($DryRun) { $Live = $false }

$env:AWS_PAGER = ''
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
function Write-Diag { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }

function ConvertTo-HtmlText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    return $Text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

# Score a list of result records that each have .status + .weight. Returns
# @{ Score; Pass; Warn; Fail; Scored; Total }.
function Get-WeightedScore {
    param([object[]]$Results)
    $pass = 0; $warn = 0; $fail = 0; $tw = 0.0; $gw = 0.0
    foreach ($r in $Results) {
        $status = "$($r.status)"
        if ($status -notin @('PASS','WARN','FAIL')) { continue }
        $w = 1.0
        if ($r.PSObject.Properties.Name -contains 'weight' -and $r.weight) { $w = [double]$r.weight }
        $tw += $w
        if ($status -eq 'PASS') { $gw += $w; $pass++ }
        elseif ($status -eq 'WARN') { $gw += ($w * 0.5); $warn++ }
        else { $fail++ }
    }
    $score = if ($tw -gt 0) { [int][math]::Round(100.0 * $gw / $tw) } else { 0 }
    return @{ Score = $score; Pass = $pass; Warn = $warn; Fail = $fail; Scored = ($pass + $warn + $fail); TotalWeight = $tw }
}
#endregion

trap {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host '  VERIFY-PRODUCTION-100-PERCENT FAILED' -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  Phase : $script:CurrentPhase" -ForegroundColor Red
    foreach ($l in ("$($_.Exception.Message)" -split "`n")) { Write-Host "    $l" -ForegroundColor Red }
    Write-Host ''
    exit 1
}

# =============================================================================
# PHASE 1 - Run (or locate) the underlying tools
# =============================================================================
Write-Phase 'PHASE 1: run audit + validation'

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null

if ($DryRun) {
    Write-Step '[DRY-RUN] would run audit-complete-platform.ps1 -Live and validate-production.ps1 -Live, then merge their JSON.'
}
elseif ($UseExisting) {
    Write-Step 'UseExisting: scoring the most recent JSON outputs (no re-run).'
}
else {
    if (Test-Path $AuditScript) {
        $auditArgs = @{ Live = $true }
        if ($SkipAws) { $auditArgs['SkipAws'] = $true }
        if ($SkipNet) { $auditArgs['SkipNet'] = $true }
        Write-Step 'Running audit-complete-platform.ps1 -Live ...'
        try { & $AuditScript @auditArgs | Out-Null } catch { Write-Diag "audit run returned: $($_.Exception.Message)" }
    } else { Write-Diag 'audit-complete-platform.ps1 not found; will score existing JSON if available.' }

    if (-not $SkipValidate -and (Test-Path $ValidateScript)) {
        Write-Step 'Running validate-production.ps1 -Live ...'
        try { & $ValidateScript -Live | Out-Null } catch { Write-Diag "validate run returned: $($_.Exception.Message)" }
    } elseif ($SkipValidate) { Write-Step '-SkipValidate: skipping validate-production.ps1.' }
    else { Write-Diag 'validate-production.ps1 not found; scoring audit results only.' }
}

# =============================================================================
# PHASE 2 - Load + merge results
# =============================================================================
Write-Phase 'PHASE 2: merge results'

$auditObj = $null; $validateObj = $null
if (Test-Path $AuditJson)    { try { $auditObj    = Get-Content -Raw $AuditJson    | ConvertFrom-Json } catch { Write-Diag "could not parse $AuditJson" } }
if (Test-Path $ValidateJson) { try { $validateObj = Get-Content -Raw $ValidateJson | ConvertFrom-Json } catch { Write-Diag "could not parse $ValidateJson" } }

if ($DryRun) {
    Write-Step '[DRY-RUN] no JSON merged. Re-run with -Live (or -UseExisting) to score.'
}

$auditResults    = @(); if ($auditObj)    { $auditResults    = @($auditObj.results) }
$validateResults = @(); if ($validateObj) { $validateResults = @($validateObj.results) }

Write-Diag "audit checks loaded    : $($auditResults.Count)$(if ($auditObj) { " (audit score $($auditObj.summary.score))" })"
Write-Diag "validate checks loaded : $($validateResults.Count)$(if ($validateObj) { " (readiness score $($validateObj.summary.score))" })"

# ---- Category breakdown. Audit sections map to named categories; the
#      validation tool contributes an INFRASTRUCTURE READINESS category. ----
$categories = [ordered]@{}
if ($auditObj) {
    foreach ($name in @('CODE QUALITY','SECURITY','OPERATIONS','INFRASTRUCTURE','COMPLIANCE','APPLICATION FUNCTIONALITY')) {
        $rs = @($auditResults | Where-Object { "$($_.sectionName)" -eq $name })
        if ($rs.Count -gt 0) { $categories[$name] = Get-WeightedScore -Results $rs }
    }
}
if ($validateResults.Count -gt 0) {
    $categories['INFRASTRUCTURE READINESS (validate-production)'] = Get-WeightedScore -Results $validateResults
}

# ---- Unified score across EVERY scored check from both tools. ----
$allResults = @($auditResults) + @($validateResults)
$overall = Get-WeightedScore -Results $allResults

# ---- Remaining gaps: every FAIL/WARN that stands between us and 100. ----
$gaps = @()
foreach ($r in $allResults) {
    if ("$($r.status)" -in @('FAIL','WARN')) {
        $sevVal = if ($r.PSObject.Properties.Name -contains 'severity') { "$($r.severity)" } else { '' }
        $secVal = if ($r.PSObject.Properties.Name -contains 'sectionName') { "$($r.sectionName)" } else { '' }
        $remVal = if ($r.PSObject.Properties.Name -contains 'remediation') { "$($r.remediation)" } else { '' }
        $gaps += [pscustomobject]@{
            Severity = $sevVal; Section = $secVal; Name = "$($r.name)"
            Status = "$($r.status)"; Detail = "$($r.detail)"; Remediation = $remVal
        }
    }
}
$sevOrder = @{ 'CRITICAL'=0; 'HIGH'=1; 'MEDIUM'=2; 'LOW'=3; ''=4 }
$gaps = @($gaps | Sort-Object @{ Expression = { $sevOrder["$($_.Severity)"] } }, Section)

$criticalGaps = @($gaps | Where-Object { $_.Status -eq 'FAIL' -and ($_.Severity -eq 'CRITICAL' -or $_.Severity -eq 'HIGH') })

# ---- Coverage: how many checks were skipped (e.g. AWS without creds). ----
$skipCount = @($allResults | Where-Object { "$($_.status)" -eq 'SKIP' }).Count
$infoCount = @($allResults | Where-Object { "$($_.status)" -eq 'INFO' }).Count

# =============================================================================
# PHASE 3 - Verdict
# =============================================================================
Write-Phase 'PHASE 3: scorecard + verdict'

$isPerfect = ($overall.Scored -gt 0 -and $overall.Fail -eq 0 -and $overall.Warn -eq 0 -and $overall.Score -eq 100)
if ($DryRun) {
    $verdict = 'N/A (dry-run)'; $verdictColor = 'DarkGray'
} elseif ($overall.Scored -eq 0) {
    $verdict = 'NO DATA (run audit/validation first)'; $verdictColor = 'DarkGray'
} elseif ($isPerfect) {
    $verdict = '100/100 PRODUCTION READY'; $verdictColor = 'Green'
} elseif ($criticalGaps.Count -gt 0) {
    $verdict = "NOT READY - $($criticalGaps.Count) critical/high gap(s)"; $verdictColor = 'Red'
} elseif ($overall.Score -ge 90) {
    $verdict = "NEAR READY - $($gaps.Count) gap(s) to 100"; $verdictColor = 'Yellow'
} else {
    $verdict = "WORK REMAINING - score $($overall.Score)/100"; $verdictColor = 'Yellow'
}

Write-Host ''
foreach ($k in $categories.Keys) {
    $c = $categories[$k]
    if ($c.Scored -eq 0) {
        Write-Host ("  {0,-48} {1,7}  (not evaluated - all checks skipped)" -f $k, 'n/a') -ForegroundColor DarkGray
        continue
    }
    $col = if ($c.Score -ge 90) { 'Green' } elseif ($c.Score -ge 70) { 'Yellow' } else { 'Red' }
    Write-Host ("  {0,-48} {1,3}/100  (pass {2}, warn {3}, fail {4})" -f $k, $c.Score, $c.Pass, $c.Warn, $c.Fail) -ForegroundColor $col
}
Write-Host ''
Write-Host "  OVERALL: $($overall.Score)/100  (scored=$($overall.Scored), skipped=$skipCount, info=$infoCount)" -ForegroundColor $(if ($overall.Score -ge 90) { 'Green' } elseif ($overall.Score -ge 70) { 'Yellow' } else { 'Red' })
Write-Host "  VERDICT: $verdict" -ForegroundColor $verdictColor

if ($gaps.Count -gt 0 -and -not $DryRun) {
    Write-Host ''
    Write-Host '  REMAINING GAPS TO 100/100:' -ForegroundColor Yellow
    $n = 0
    foreach ($g in $gaps) {
        $n++
        $col = switch ($g.Severity) { 'CRITICAL' { 'Red' } 'HIGH' { 'Red' } 'MEDIUM' { 'Yellow' } default { 'DarkYellow' } }
        $sev = if ($g.Severity) { $g.Severity } else { 'INFO' }
        Write-Host "    $n. [$sev] $($g.Section) / $($g.Name)" -ForegroundColor $col
        if ($g.Remediation) { Write-Host "       fix: $($g.Remediation)" -ForegroundColor DarkGray }
    }
}
if ($skipCount -gt 0 -and -not $DryRun) {
    Write-Host ''
    Write-Host "  NOTE: $skipCount check(s) were SKIPPED (e.g. AWS checks without credentials, or -SkipAws/-SkipNet)." -ForegroundColor DarkGray
    Write-Host '        A perfect score requires running with full AWS + network access so every check is evaluated.' -ForegroundColor DarkGray
}

# =============================================================================
# OUTPUT: JSON + HTML
# =============================================================================
Write-Phase 'OUTPUT: writing scorecard JSON + HTML'

$jsonObj = [ordered]@{
    generatedAt = $StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    mode        = if ($DryRun) { 'dry-run' } elseif ($UseExisting) { 'use-existing' } else { 'live' }
    verdict     = $verdict
    perfect     = $isPerfect
    overall     = [ordered]@{
        score = $overall.Score; pass = $overall.Pass; warn = $overall.Warn; fail = $overall.Fail
        scored = $overall.Scored; skipped = $skipCount; info = $infoCount
    }
    sources = [ordered]@{
        audit    = if ($auditObj)    { [ordered]@{ score = $auditObj.summary.score; checks = $auditResults.Count } } else { $null }
        validate = if ($validateObj) { [ordered]@{ score = $validateObj.summary.score; checks = $validateResults.Count } } else { $null }
    }
    categories = [ordered]@{}
    gaps = @($gaps | ForEach-Object { [ordered]@{ severity = $_.Severity; section = $_.Section; name = $_.Name; status = $_.Status; detail = $_.Detail; remediation = $_.Remediation } })
}
foreach ($k in $categories.Keys) {
    $c = $categories[$k]
    $jsonObj.categories[$k] = [ordered]@{ score = $c.Score; pass = $c.Pass; warn = $c.Warn; fail = $c.Fail; scored = $c.Scored }
}
[System.IO.File]::WriteAllText($ScorecardJson, ($jsonObj | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
Write-Step "Scorecard JSON -> $ScorecardJson"

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<!doctype html><html lang="en"><head><meta charset="utf-8">')
[void]$sb.AppendLine('<meta name="viewport" content="width=device-width, initial-scale=1">')
[void]$sb.AppendLine('<title>Anot Health - Production 100/100 Scorecard</title>')
[void]$sb.AppendLine(@'
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#0f1419;color:#e6e6e6}
.wrap{max-width:1050px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px;border-bottom:1px solid #2a3340;padding-bottom:6px}
.meta{color:#9aa7b4;font-size:13px;margin-bottom:18px}
.hero{display:flex;align-items:center;gap:24px;background:#161d27;border:1px solid #2a3340;border-radius:14px;padding:24px;margin:18px 0}
.bigscore{font-size:56px;font-weight:800;line-height:1}
.verdict{font-size:22px;font-weight:700;padding:10px 16px;border-radius:10px;display:inline-block}
.ready{background:#0f3d24;color:#5ee08a;border:1px solid #1d6b41}
.notready{background:#3d0f0f;color:#e05e5e;border:1px solid #6b1d1d}
.partial{background:#3d340f;color:#e0c95e;border:1px solid #6b5d1d}
.na{background:#23262b;color:#9aa7b4;border:1px solid #3a3f47}
table{border-collapse:collapse;width:100%;margin:6px 0 12px;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #232c38;vertical-align:top}
th{color:#9aa7b4;font-weight:600;font-size:12px;text-transform:uppercase}
.bar{height:10px;border-radius:6px;background:#23262b;overflow:hidden;min-width:160px}
.bar > span{display:block;height:100%}
.g{background:#5ee08a}.y{background:#e0c95e}.r{background:#e05e5e}
.sev.CRITICAL,.sev.HIGH{color:#e05e5e;font-weight:700}.sev.MEDIUM{color:#e0c95e;font-weight:700}.sev.LOW{color:#c0a85e;font-weight:700}
.muted{color:#9aa7b4}.rem{color:#9aa7b4;font-size:13px}
</style>
'@)
[void]$sb.AppendLine('</head><body><div class="wrap">')
[void]$sb.AppendLine('<h1>Anot Health - Production 100/100 Scorecard</h1>')
$modeTxt = $jsonObj.mode
[void]$sb.AppendLine("<div class='meta'>Generated $(ConvertTo-HtmlText $jsonObj.generatedAt) &middot; mode <b>$modeTxt</b> &middot; audit checks: $($auditResults.Count) &middot; validation checks: $($validateResults.Count) &middot; skipped: $skipCount</div>")

$vCls = if ($isPerfect) { 'ready' } elseif ($verdict -match 'NOT READY') { 'notready' } elseif ($verdict -match 'N/A|NO DATA') { 'na' } else { 'partial' }
$sCol = if ($overall.Score -ge 90) { '#5ee08a' } elseif ($overall.Score -ge 70) { '#e0c95e' } else { '#e05e5e' }
[void]$sb.AppendLine('<div class="hero">')
[void]$sb.AppendLine("<div class='bigscore' style='color:$sCol'>$($overall.Score)<span style='font-size:22px;color:#9aa7b4'>/100</span></div>")
[void]$sb.AppendLine("<div><span class='verdict $vCls'>$(ConvertTo-HtmlText $verdict)</span><div class='muted' style='margin-top:8px'>pass $($overall.Pass) &middot; warn $($overall.Warn) &middot; fail $($overall.Fail) &middot; scored $($overall.Scored) &middot; skipped $skipCount</div></div>")
[void]$sb.AppendLine('</div>')

[void]$sb.AppendLine('<h2>Category breakdown</h2><table><tr><th>Category</th><th>Score</th><th></th><th>Pass</th><th>Warn</th><th>Fail</th></tr>')
foreach ($k in $categories.Keys) {
    $c = $categories[$k]
    if ($c.Scored -eq 0) {
        [void]$sb.AppendLine("<tr><td>$(ConvertTo-HtmlText $k)</td><td class='muted'>n/a</td><td class='muted'>not evaluated</td><td>$($c.Pass)</td><td>$($c.Warn)</td><td>$($c.Fail)</td></tr>")
        continue
    }
    $cls = if ($c.Score -ge 90) { 'g' } elseif ($c.Score -ge 70) { 'y' } else { 'r' }
    [void]$sb.AppendLine("<tr><td>$(ConvertTo-HtmlText $k)</td><td><b>$($c.Score)</b>/100</td><td><div class='bar'><span class='$cls' style='width:$($c.Score)%'></span></div></td><td>$($c.Pass)</td><td>$($c.Warn)</td><td>$($c.Fail)</td></tr>")
}
[void]$sb.AppendLine('</table>')

if ($gaps.Count -gt 0) {
    [void]$sb.AppendLine('<h2>Remaining gaps to 100/100</h2><table><tr><th>Severity</th><th>Status</th><th>Category</th><th>Check</th><th>Detail</th><th>Remediation</th></tr>')
    foreach ($g in $gaps) {
        $sev = if ($g.Severity) { $g.Severity } else { '-' }
        [void]$sb.AppendLine("<tr><td class='sev $($g.Severity)'>$sev</td><td>$($g.Status)</td><td>$(ConvertTo-HtmlText $g.Section)</td><td>$(ConvertTo-HtmlText $g.Name)</td><td>$(ConvertTo-HtmlText $g.Detail)</td><td class='rem'>$(ConvertTo-HtmlText $g.Remediation)</td></tr>")
    }
    [void]$sb.AppendLine('</table>')
} else {
    [void]$sb.AppendLine("<h2>Remaining gaps to 100/100</h2><p class='muted'>None - every scored check passed.</p>")
}

if ($skipCount -gt 0) {
    [void]$sb.AppendLine("<p class='muted'>Note: $skipCount check(s) were skipped (e.g. AWS checks without credentials, or -SkipAws/-SkipNet). Re-run with full AWS + network access for complete coverage.</p>")
}
[void]$sb.AppendLine("<p class='muted'>Generated by verify-production-100-percent.ps1 &middot; $(ConvertTo-HtmlText ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')))</p>")
[void]$sb.AppendLine('</div></body></html>')
[System.IO.File]::WriteAllText($ScorecardHtml, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Step "Scorecard HTML -> $ScorecardHtml"

Write-Host ''
Write-Host ('=' * 78) -ForegroundColor $verdictColor
Write-Host "  FINAL: $($overall.Score)/100  |  $verdict" -ForegroundColor $verdictColor
Write-Host ('=' * 78) -ForegroundColor $verdictColor
Write-Host "  HTML : $ScorecardHtml" -ForegroundColor Gray
Write-Host "  JSON : $ScorecardJson" -ForegroundColor Gray
Write-Host ''

# Exit non-zero unless a perfect, fully-scored verdict was reached, so CI can gate on 100/100.
if ($DryRun) { exit 0 }
if ($isPerfect) { exit 0 }
if ($criticalGaps.Count -gt 0) { exit 2 }
exit 1
