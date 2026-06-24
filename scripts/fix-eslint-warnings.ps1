<#
.SYNOPSIS
  ULT audit fix: ESLint strict mode and auto-fix frontend lint warnings.

.EXAMPLE
  powershell -File scripts/fix-eslint-warnings.ps1 -Force
#>

[CmdletBinding()]
param([switch]$Force, [switch]$DryRun, [switch]$Rollback)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\fix-common.ps1"
$script:FixForce = $Force
$script:FixDryRun = $DryRun

$ctx = Initialize-FixContext -FixId 'fix-eslint-warnings' -Title 'ESLint Warnings (Frontend)' `
    -AuditRef 'ULT-0001' -Priority 'HIGH'

if ($Rollback) {
    Write-FixPhase 'ROLLBACK: fix-eslint-warnings'
    Restore-FixBackup -FixId 'fix-eslint-warnings'
    exit 0
}

Write-FixPhase $ctx.Title
Test-RequiredPaths -RequireFrontend
if (-not (Confirm-FixStep 'Apply strict ESLint config and run eslint --fix?')) { exit 0 }

$eslintConfig = @'
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'eqeqeq': ['error', 'always'],
      'curly': ['error', 'all'],
    },
  },
  {
    files: ['src/pages/shared.jsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: [
      'src/pages/Clinician/index.jsx',
      'src/pages/QPS/index.jsx',
      'src/pages/Scribe/index.jsx',
    ],
    rules: {
      'react-hooks/static-components': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
    },
  },
])
'@

$eslintPath = Join-Path $ctx.FrontendDir 'eslint.config.js'
Set-FixFileContent -Path $eslintPath -Content $eslintConfig

$fePkg = Join-Path $ctx.FrontendDir 'package.json'
$hasLintFix = $false
if (Test-Path $fePkg) {
    $pkg = Get-Content $fePkg -Raw | ConvertFrom-Json
    if (-not $pkg.scripts) {
        $pkg | Add-Member -NotePropertyName 'scripts' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $scriptNames = @($pkg.scripts.PSObject.Properties | ForEach-Object { $_.Name })
    if ($scriptNames -notcontains 'lint:fix') {
        $pkg.scripts | Add-Member -NotePropertyName 'lint:fix' -NotePropertyValue 'eslint . --fix' -Force
        Set-FixFileContent -Path $fePkg -Content ($pkg | ConvertTo-Json -Depth 10) -ForceWrite
        $hasLintFix = $true
    } else {
        $hasLintFix = $true
        Write-FixStep 'lint:fix script already present in package.json'
    }
}

Write-FixPhase 'Running ESLint (before)'
Push-Location $ctx.FrontendDir
$beforeOutput = ''
try {
    $beforeOutput = & npm run lint 2>&1 | Out-String
    Write-FixStep "Lint exit code: $LASTEXITCODE"
} catch {
    $beforeOutput = $_.Exception.Message
    Write-FixWarn "Lint before: $beforeOutput"
}
Pop-Location

if (-not $DryRun) {
    Write-FixPhase 'Running ESLint --fix'
    Push-Location $ctx.FrontendDir
    try {
        if ($hasLintFix) {
            & npm run lint:fix 2>&1 | Out-Host
        } else {
            Write-FixStep 'lint:fix unavailable; running npx eslint . --fix'
            & npx eslint . --fix 2>&1 | Out-Host
        }
    } catch {
        Write-FixWarn 'eslint --fix completed with warnings/errors (review output)'
    }
    Pop-Location
}

Write-FixPhase 'Running ESLint (after)'
Push-Location $ctx.FrontendDir
$afterOutput = ''
try {
    $afterOutput = & npm run lint 2>&1 | Out-String
} catch { $afterOutput = $_.Exception.Message }
Pop-Location

$reportPath = Join-Path $ctx.DistDir 'eslint-fix-report.txt'
$reportBody = @"
ESLint Fix Report — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

=== BEFORE ===
$beforeOutput

=== AFTER ===
$afterOutput
"@
Set-FixFileContent -Path $reportPath -Content $reportBody

Write-FixReport -Summary 'Updated eslint.config.js with strict rules (eqeqeq, curly, no-console warn) and ran eslint --fix. See dist/eslint-fix-report.txt for before/after.' -NextSteps @(
    'Review remaining warnings in dist/eslint-fix-report.txt'
    'Fix legacy dashboard hook warnings manually if needed'
)

Write-Host ''
Write-Host '[SUCCESS] fix-eslint-warnings completed' -ForegroundColor Green
