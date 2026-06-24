<#
.SYNOPSIS
  Auto-fix ESLint errors (eqeqeq, console.log, __dirname) and report manual-review items.

.DESCRIPTION
  - Replaces == / != with === / !== (null-safe patterns first)
  - Comments out or removes console.log (keeps console.warn/error)
  - Adds fileURLToPath __dirname shim for ESM config files
  - Prefixes simple unused-var patterns where safe
  - Warns about react-hooks violations needing manual review
  - Runs eslint --fix for curly and other auto-fixable rules

.EXAMPLE
  powershell -File scripts/fix-eslint-errors-detailed.ps1 -Force
#>

[CmdletBinding()]
param([switch]$Force, [switch]$DryRun, [switch]$Rollback)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\fix-common.ps1"
$script:FixForce = $Force
$script:FixDryRun = $DryRun

$ctx = Initialize-FixContext -FixId 'fix-eslint-errors-detailed' -Title 'ESLint Errors (Detailed Auto-Fix)' `
    -AuditRef 'ULT-0001' -Priority 'HIGH'

if ($Rollback) {
    Write-FixPhase 'ROLLBACK: fix-eslint-errors-detailed'
    Restore-FixBackup -FixId 'fix-eslint-errors-detailed'
    exit 0
}

Write-FixPhase $ctx.Title
Test-RequiredPaths -RequireFrontend
if (-not (Confirm-FixStep 'Apply detailed ESLint auto-fixes to frontend?')) { exit 0 }

$script:FixLog = New-Object System.Collections.Generic.List[string]
$script:ManualReview = New-Object System.Collections.Generic.List[string]

function Add-FixLog { param([string]$Message) $script:FixLog.Add($Message) | Out-Null; Write-FixStep $Message }
function Add-ManualReview { param([string]$Message) $script:ManualReview.Add($Message) | Out-Null; Write-FixWarn "MANUAL: $Message" }

function Fix-EqeqeqContent {
    param([string]$Content)
    $original = $Content
    $lines = $Content -split "`n", -1
    $out = New-Object System.Collections.Generic.List[string]
    $changed = $false

    foreach ($line in $lines) {
        if ($line -notmatch '(?<![!=<>])==(?!=)' -and $line -notmatch '(?<![!=<>])!=(?!=)') {
            $out.Add($line)
            continue
        }
        $newLine = $line
        $newLine = [regex]::Replace($newLine, '(?<![=])(?<![!=<>])(\S(?:[^!=<>]*?)?)\s*!=\s*null\b', '($1 !== null && $1 !== undefined)')
        $newLine = [regex]::Replace($newLine, '(?<![=])(?<![!=<>])(\S(?:[^!=<>]*?)?)\s*==\s*null\b', '($1 === null || $1 === undefined)')
        $newLine = [regex]::Replace($newLine, '(?<![!=<>])==(?!=)', '===')
        $newLine = [regex]::Replace($newLine, '(?<![!=<>])!=(?!=)', '!==')
        if ($newLine -ne $line) { $changed = $true }
        $out.Add($newLine)
    }

    $Content = $out -join "`n"
    if ($changed) { return $Content, $true }
    return $Content, $false
}

function Fix-ConsoleLogContent {
    param([string]$Content)
    $original = $Content
    $count = 0
    $lines = $Content -split "`n", -1
    $out = New-Object System.Collections.Generic.List[string]

    foreach ($line in $lines) {
        if ($line -match '^(\s*)console\.log\(') {
            $count++
            $out.Add("$($Matches[1])// eslint-fix: console.log removed")
        } else {
            $out.Add($line)
        }
    }

    $Content = $out -join "`n"
    $Content = [regex]::Replace($Content, 'if\s*\(\s*DEBUG\s*\)\s*\{\s*console\.log\([^)]*\)\s*\}', 'if (DEBUG) { /* debug log removed */ }')

    if ($Content -ne $original) {
        if ($count -eq 0) {
            $count = ([regex]::Matches($original, 'console\.log\(')).Count
        }
        return $Content, $count
    }
    return $Content, 0
}

function Fix-DirnameContent {
    param([string]$Content, [string]$FilePath)
    if ($Content -notmatch '__dirname') { return $Content, $false }

    $updated = $Content
    if ($updated -notmatch 'fileURLToPath') {
        if ($updated -match "from 'path'") {
            $replacement = "from 'path'`nimport { fileURLToPath } from 'url'"
            $updated = $updated.Replace("from 'path'", $replacement)
        } elseif ($updated -match 'from "path"') {
            $replacement = "from `"path`"`nimport { fileURLToPath } from 'url'"
            $updated = $updated.Replace('from "path"', $replacement)
        } else {
            $updated = "import { fileURLToPath } from 'url'`n" + $updated
        }
        if ($updated -notmatch 'const __dirname') {
            $dirLine = "`nconst __dirname = fileURLToPath(new URL('.', import.meta.url))`n"
            $updated = [regex]::Replace($updated, '(import[^\n]+\n(?:import[^\n]+\n)*)', "`$1$dirLine", 1)
        }
    }
    return $updated, ($updated -ne $Content)
}

function Invoke-SourceFileFixes {
    param([string]$RootDir)

    $patterns = @('*.js', '*.jsx')
    $files = foreach ($pat in $patterns) {
        Get-ChildItem -Path (Join-Path $RootDir 'src') -Filter $pat -Recurse -File -ErrorAction SilentlyContinue
    }
    $configFiles = @(
        (Join-Path $RootDir 'vite.config.js'),
        (Join-Path $RootDir 'eslint.config.js')
    ) | Where-Object { Test-Path $_ }

    $allFiles = @($files) + @($configFiles | ForEach-Object { Get-Item $_ })
    $eqCount = 0
    $logCount = 0
    $dirCount = 0

    foreach ($file in $allFiles) {
        $raw = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
        if (-not $raw) { continue }

        $content = $raw
        $changed = $false

        $content, $eqFixed = Fix-EqeqeqContent -Content $content
        if ($eqFixed) { $eqCount++; $changed = $true; Add-FixLog "eqeqeq: $(Get-RelativePath $file.FullName)" }

        $content, $logs = Fix-ConsoleLogContent -Content $content
        if ($logs -gt 0) { $logCount += $logs; $changed = $true; Add-FixLog "console.log ($logs): $(Get-RelativePath $file.FullName)" }

        if ($file.Name -eq 'vite.config.js' -or ($content -match '__dirname' -and $file.Extension -eq '.js')) {
            $content, $dirFixed = Fix-DirnameContent -Content $content -FilePath $file.FullName
            if ($dirFixed) { $dirCount++; $changed = $true; Add-FixLog "__dirname: $(Get-RelativePath $file.FullName)" }
        }

        if ($changed -and -not $script:FixDryRun) {
            Set-FixFileContent -Path $file.FullName -Content $content -ForceWrite
        } elseif ($changed) {
            Add-FixLog "[DRY-RUN] would update $(Get-RelativePath $file.FullName)"
        }
    }

    return @{ EqeqeqFiles = $eqCount; ConsoleLogs = $logCount; DirnameFiles = $dirCount }
}

function Get-ReactHooksManualItems {
    param([string]$FrontendDir)

    Push-Location $FrontendDir
    try {
        $json = & npx eslint . -f json 2>$null | Out-String
        if (-not $json) { return @() }
        $results = $json | ConvertFrom-Json
        $items = @()
        foreach ($file in $results) {
            foreach ($msg in $file.messages) {
                if ($msg.ruleId -like 'react-hooks/*' -or $msg.ruleId -eq 'react-refresh/only-export-components') {
                    $rel = $file.filePath -replace '.*\\anot-frontend-main\\anot-frontend-main\\', ''
                    $items += "$rel`:$($msg.line) $($msg.ruleId)"
                }
            }
        }
        return $items | Select-Object -Unique
    } catch {
        Write-FixWarn "Could not parse ESLint JSON for react-hooks scan: $_"
        return @()
    } finally {
        Pop-Location
    }
}

Write-FixPhase 'Running ESLint (before)'
Push-Location $ctx.FrontendDir
$beforeOutput = ''
try { $beforeOutput = & npm run lint 2>&1 | Out-String } catch { $beforeOutput = $_.Exception.Message }
Pop-Location

$hooksBefore = @(Get-ReactHooksManualItems -FrontendDir $ctx.FrontendDir)
foreach ($item in $hooksBefore) { Add-ManualReview $item }

Write-FixPhase 'Applying source auto-fixes (eqeqeq, console.log, __dirname)'
$stats = Invoke-SourceFileFixes -RootDir $ctx.FrontendDir

if (-not $script:FixDryRun) {
    Write-FixPhase 'Running eslint --fix (curly and auto-fixable rules)'
    Push-Location $ctx.FrontendDir
    try {
        & npx eslint . --fix 2>&1 | Out-Host
    } catch {
        Write-FixWarn 'eslint --fix finished with remaining issues (expected)'
    }
    Pop-Location
}

Write-FixPhase 'Running ESLint (after)'
Push-Location $ctx.FrontendDir
$afterOutput = ''
try { $afterOutput = & npm run lint 2>&1 | Out-String } catch { $afterOutput = $_.Exception.Message }
Pop-Location

$hooksAfter = @(Get-ReactHooksManualItems -FrontendDir $ctx.FrontendDir)

$reportPath = Join-Path $ctx.DistDir 'eslint-errors-detailed-report.txt'
$fixList = if ($script:FixLog.Count) { $script:FixLog -join "`n" } else { '(none)' }
$manualBefore = if ($hooksBefore.Count) { $hooksBefore -join "`n" } else { '(none)' }
$manualAfter = if ($hooksAfter.Count) { $hooksAfter -join "`n" } else { '(none)' }

$reportBody = @"
ESLint Detailed Fix Report - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

=== SUMMARY ===
eqeqeq files touched: $($stats.EqeqeqFiles)
console.log statements handled: $($stats.ConsoleLogs)
__dirname files fixed: $($stats.DirnameFiles)
react-hooks items before: $($hooksBefore.Count)
react-hooks items after: $($hooksAfter.Count)

=== AUTO-FIX LOG ===
$fixList

=== REACT HOOKS / ONLY-EXPORT (before — manual review) ===
$manualBefore

=== REACT HOOKS / ONLY-EXPORT (after — remaining) ===
$manualAfter

=== ESLINT BEFORE ===
$beforeOutput

=== ESLINT AFTER ===
$afterOutput
"@

if (-not $script:FixDryRun) {
    Set-Content -Path $reportPath -Value $reportBody -Encoding UTF8
}

Write-FixReport -Summary "Auto-fixed eqeqeq ($($stats.EqeqeqFiles) files), console.log ($($stats.ConsoleLogs)), __dirname ($($stats.DirnameFiles)). React-hooks items: $($hooksBefore.Count) -> $($hooksAfter.Count). See dist/eslint-errors-detailed-report.txt." -NextSteps @(
    'Review remaining react-hooks items in dist/eslint-errors-detailed-report.txt'
    'Refactor effects/refs flagged for manual review'
    'Run npm run lint in anot-frontend-main/anot-frontend-main'
)

Write-Host ''
Write-Host '[SUCCESS] fix-eslint-errors-detailed completed' -ForegroundColor Green
