<#
.SYNOPSIS
  Run all ultimate-audit fix scripts in priority order.

.DESCRIPTION
  Executes 15 fix scripts (high priority first, then medium).
  Tracks success/failure and writes a summary report to dist/fix-reports/.

.PARAMETER Force
  Pass -Force to each fix script (skip confirmations).

.PARAMETER DryRun
  Pass -DryRun to each fix script (preview only).

.PARAMETER Rollback
  Pass -Rollback to each fix script (restore from backups).

.PARAMETER HighPriorityOnly
  Run only the 11 high-priority fixes (skip medium).

.EXAMPLE
  powershell -File scripts/run-all-audit-fixes.ps1 -Force
  powershell -File scripts/run-all-audit-fixes.ps1 -DryRun
  powershell -File scripts/run-all-audit-fixes.ps1 -Rollback
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$DryRun,
    [switch]$Rollback,
    [switch]$HighPriorityOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$scriptDir   = $PSScriptRoot
$workspace   = Split-Path -Parent $scriptDir
$reportDir   = Join-Path $workspace 'dist\fix-reports'
$summaryJson = Join-Path $reportDir 'run-all-summary.json'
$summaryMd   = Join-Path $reportDir 'run-all-summary.md'

if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}

$highPriority = @(
    'fix-unit-tests.ps1',
    'fix-ci-cd-pipeline.ps1',
    'fix-csrf-protection.ps1',
    'fix-rds-performance-insights.ps1',
    'fix-foreign-keys.ps1',
    'fix-dom-xss.ps1',
    'fix-correlation-ids.ps1',
    'fix-user-consent.ps1',
    'fix-mfa-auth.ps1',
    'fix-eslint-warnings.ps1',
    'fix-dead-code.ps1'
)

$mediumPriority = @(
    'fix-api-documentation.ps1',
    'fix-load-testing.ps1',
    'fix-landscape-css.ps1',
    'fix-confidence-scores.ps1'
)

$toRun = @($highPriority)
if (-not $HighPriorityOnly) {
    $toRun += $mediumPriority
}

$mode = if ($Rollback) { 'ROLLBACK' } elseif ($DryRun) { 'DRY-RUN' } elseif ($Force) { 'FORCE' } else { 'INTERACTIVE' }

Write-Host ''
Write-Host ('=' * 72) -ForegroundColor Cyan
Write-Host '  Run All Ultimate Audit Fixes' -ForegroundColor Cyan
Write-Host ('=' * 72) -ForegroundColor Cyan
Write-Host "  Mode:            $mode" -ForegroundColor Gray
Write-Host "  Scripts to run:  $($toRun.Count)" -ForegroundColor Gray
Write-Host "  High only:       $HighPriorityOnly" -ForegroundColor Gray
Write-Host ''

$startTime = Get-Date
$results   = New-Object System.Collections.Generic.List[object]
$index     = 0

foreach ($name in $toRun) {
    $index++
    $path = Join-Path $scriptDir $name

    Write-Host ('-' * 72) -ForegroundColor DarkGray
    Write-Host "  [$index/$($toRun.Count)] $name" -ForegroundColor Cyan

    if (-not (Test-Path $path)) {
        Write-Host '  [SKIP] Script file not found' -ForegroundColor Yellow
        $results.Add([pscustomobject]@{
            Order    = $index
            Script   = $name
            Status   = 'SKIP'
            ExitCode = $null
            Message  = 'File not found'
        }) | Out-Null
        continue
    }

    $invokeArgs = @('-NoProfile', '-File', $path)
    if ($Force)    { $invokeArgs += '-Force' }
    if ($DryRun)   { $invokeArgs += '-DryRun' }
    if ($Rollback) { $invokeArgs += '-Rollback' }

    $scriptStart = Get-Date
    try {
        & powershell @invokeArgs
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
    } catch {
        $exitCode = 1
        Write-Host "  [ERROR] $_" -ForegroundColor Red
    }
    $elapsed = ((Get-Date) - $scriptStart).TotalSeconds

    if ($exitCode -eq 0) {
        $status = 'OK'
        Write-Host ("  [OK] Completed in {0:0.1f}s" -f $elapsed) -ForegroundColor Green
    } else {
        $status = 'FAIL'
        Write-Host ("  [FAIL] Exit code {0} ({1:0.1f}s)" -f $exitCode, $elapsed) -ForegroundColor Red
    }

    $results.Add([pscustomobject]@{
        Order    = $index
        Script   = $name
        Status   = $status
        ExitCode = $exitCode
        Seconds  = [math]::Round($elapsed, 1)
        Message  = ''
    }) | Out-Null
}

$totalSeconds = ((Get-Date) - $startTime).TotalSeconds
$okCount      = @($results | Where-Object { $_.Status -eq 'OK' }).Count
$failCount    = @($results | Where-Object { $_.Status -eq 'FAIL' }).Count
$skipCount    = @($results | Where-Object { $_.Status -eq 'SKIP' }).Count

Write-Host ''
Write-Host ('=' * 72) -ForegroundColor Cyan
Write-Host '  Summary' -ForegroundColor Cyan
Write-Host ('=' * 72) -ForegroundColor Cyan
Write-Host "  OK:   $okCount" -ForegroundColor Green
Write-Host "  FAIL: $failCount" -ForegroundColor $(if ($failCount -gt 0) { 'Red' } else { 'Gray' })
Write-Host "  SKIP: $skipCount" -ForegroundColor Yellow
Write-Host ("  Total time: {0:0.1f}s" -f $totalSeconds) -ForegroundColor Gray
Write-Host ''

$results | Format-Table Order, Script, Status, ExitCode, Seconds -AutoSize

$summaryObj = [ordered]@{
    generated   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    mode        = $mode
    durationSec = [math]::Round($totalSeconds, 1)
    totals      = @{ ok = $okCount; fail = $failCount; skip = $skipCount }
    results     = @($results | ForEach-Object {
        @{
            order    = $_.Order
            script   = $_.Script
            status   = $_.Status
            exitCode = $_.ExitCode
            seconds  = $_.Seconds
            message  = $_.Message
        }
    })
}

try {
    $summaryObj | ConvertTo-Json -Depth 6 | Set-Content -Path $summaryJson -Encoding UTF8
} catch {
    Write-Host "  [WARN] Could not write JSON summary: $_" -ForegroundColor Yellow
}

$rows = ($results | ForEach-Object {
    "| $($_.Order) | $($_.Script) | $($_.Status) | $($_.ExitCode) | $($_.Seconds)s |"
}) -join "`n"

$md = @"
# Run All Audit Fixes - Summary

- **Generated:** $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
- **Mode:** $mode
- **Duration:** $([math]::Round($totalSeconds, 1))s
- **OK / FAIL / SKIP:** $okCount / $failCount / $skipCount

## Results

| # | Script | Status | Exit | Time |
|---|--------|--------|------|------|
$rows

## Usage

Run with -Force, -DryRun, -Rollback, or -HighPriorityOnly.
See scripts/AUDIT-FIX-SCRIPTS-INDEX.md for details.
"@

Set-Content -Path $summaryMd -Value $md -Encoding UTF8

Write-Host "Summary JSON: $summaryJson" -ForegroundColor Cyan
Write-Host "Summary MD:   $summaryMd" -ForegroundColor Cyan

if ($failCount -gt 0) {
    exit 1
}
exit 0
