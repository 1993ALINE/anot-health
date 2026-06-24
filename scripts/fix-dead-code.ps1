<#
.SYNOPSIS
  ULT audit fix: Dead code detection and cleanup of unused imports.

.EXAMPLE
  powershell -File scripts/fix-dead-code.ps1 -Force
#>

[CmdletBinding()]
param([switch]$Force, [switch]$DryRun, [switch]$Rollback)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\fix-common.ps1"
$script:FixForce = $Force
$script:FixDryRun = $DryRun

$ctx = Initialize-FixContext -FixId 'fix-dead-code' -Title 'Dead Code Removal' `
    -AuditRef 'ULT-0002' -Priority 'HIGH'

if ($Rollback) {
    Write-FixPhase 'ROLLBACK: fix-dead-code'
    Restore-FixBackup -FixId 'fix-dead-code'
    exit 0
}

Write-FixPhase $ctx.Title
Test-RequiredPaths -RequireBackend -RequireFrontend
if (-not (Confirm-FixStep 'Scan for dead code and remove unused imports?')) { exit 0 }

function Find-PotentiallyUnusedExports {
    param([string]$Root)
    $files = Get-ChildItem -Path $Root -Recurse -Include *.js,*.jsx -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch 'node_modules|__tests__|dist' }
    $exports = @{}
    foreach ($f in $files) {
        $content = Get-Content $f.FullName -Raw
        $matches = [regex]::Matches($content, '(?m)^export (?:async )?(?:function|const|class) (\w+)')
        foreach ($m in $matches) {
            $name = $m.Groups[1].Value
            if (-not $exports.ContainsKey($name)) { $exports[$name] = @() }
            $exports[$name] += $f.FullName
        }
    }
    $unused = @()
    foreach ($name in $exports.Keys) {
        $importHits = 0
        foreach ($f in $files) {
            if ($f.FullName -in $exports[$name]) { continue }
            $c = Get-Content $f.FullName -Raw
            if ($c -match [regex]::Escape($name)) { $importHits++; break }
        }
        if ($importHits -eq 0 -and @($exports[$name]).Count -eq 1) {
            $unused += [pscustomobject]@{ Name = $name; File = (@($exports[$name]))[0] }
        }
    }
    return $unused
}

Write-FixPhase 'Scanning backend'
$beUnused = Find-PotentiallyUnusedExports -Root (Join-Path $ctx.BackendDir 'src')
Write-FixStep "Potentially unused exports (backend): $(@($beUnused).Count)"

Write-FixPhase 'Scanning frontend'
$feUnused = Find-PotentiallyUnusedExports -Root (Join-Path $ctx.FrontendDir 'src')
Write-FixStep "Potentially unused exports (frontend): $(@($feUnused).Count)"

Write-FixPhase 'Removing unused import lines (safe pattern)'
$cleaned = 0
foreach ($root in @((Join-Path $ctx.BackendDir 'src'), (Join-Path $ctx.FrontendDir 'src'))) {
    Get-ChildItem -Path $root -Recurse -Include *.js,*.jsx | ForEach-Object {
        $lines = Get-Content $_.FullName
        $newLines = @()
        $changed = $false
        foreach ($line in $lines) {
            if ($line -match '^\s*import\s+.+\s+from\s+[''"][^''"]+[''"]\s*;\s*$' -and
                $line -match '\{\s*(\w+)\s*\}') {
                $sym = $Matches[1]
                $body = ($lines -join "`n") -replace [regex]::Escape($line), ''
                if ($body -notmatch [regex]::Escape($sym)) {
                    $changed = $true
                    $cleaned++
                    continue
                }
            }
            $newLines += $line
        }
        if ($changed -and -not $DryRun) {
            Backup-FileIfExists -Path $_.FullName | Out-Null
            Set-Content -Path $_.FullName -Value ($newLines -join "`n") -Encoding UTF8
            $ctx.Modified.Add($_.FullName) | Out-Null
        }
    }
}
Write-FixOk "Cleaned $cleaned unused single-import lines"

$reportMd = @"
# Dead Code Analysis Report

Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

## Summary

| Area | Potentially unused exports |
|------|---------------------------:|
| Backend | $(@($beUnused).Count) |
| Frontend | $(@($feUnused).Count) |
| Unused import lines removed | $cleaned |

## Backend candidates (manual review)

$(if (@($beUnused).Count -gt 0) { ($beUnused | ForEach-Object { "- $($_.Name) in $($_.File)" }) -join "`n" } else { '_None detected_' })

## Frontend candidates (manual review)

$(if (@($feUnused).Count -gt 0) { ($feUnused | ForEach-Object { "- $($_.Name) in $($_.File)" }) -join "`n" } else { '_None detected_' })

## Rollback

Run: powershell -File scripts/fix-dead-code.ps1 -Rollback
"@

Set-FixFileContent -Path (Join-Path $ctx.DistDir 'dead-code-report.md') -Content $reportMd

Write-FixReport -Summary "Scanned for unused exports and removed $cleaned orphaned single-symbol import lines. Full report in dist/dead-code-report.md." -NextSteps @(
    'Review dist/dead-code-report.md for manual cleanup candidates'
    'Do not delete shared utilities without confirming zero references'
)

Write-Host ''
Write-Host '[SUCCESS] fix-dead-code completed' -ForegroundColor Green
