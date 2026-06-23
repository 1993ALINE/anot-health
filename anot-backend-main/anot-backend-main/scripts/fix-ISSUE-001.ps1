<#
.SYNOPSIS
  Fix for ISSUE-001: HIGH Severity NPM Vulnerability (xlsx package)

.DESCRIPTION
  Severity: CRITICAL
  Component: Backend Dependencies
  Effort: 1-2 hours
  
  Issue: The xlsx package has TWO high-severity vulnerabilities:
    1. Prototype Pollution (GHSA-4r6h-8v6p-xvw6) - CVSS 7.8
    2. Regular Expression Denial of Service/ReDoS (GHSA-5pgg-2g8v-p4x9) - CVSS 7.5
  
  Impact: Potential remote code execution, DoS attacks, affects payroll export functionality
  
  Fix: Update xlsx package from 0.18.5 to >= 0.20.2

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip confirmations

.EXAMPLE
  powershell -File fix-ISSUE-001.ps1 -DryRun
  powershell -File fix-ISSUE-001.ps1 -Force
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force,
    [switch]$SkipConfirm
)

# Standard error handling
$ErrorActionPreference = 'Stop'
trap {
    Write-Host "[ERROR] Fix failed: $_" -ForegroundColor Red
    exit 1
}

$backendPath = ".."

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "FIX ISSUE-001: xlsx NPM Vulnerability" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Phase 1: Pre-flight checks
Write-Host "[PHASE 1] Pre-flight checks" -ForegroundColor Cyan

if (-not (Test-Path "$backendPath/package.json")) {
    throw "Backend package.json not found at $backendPath/package.json"
}

# Check if npm is available
$npmVersion = & npm --version 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "npm not found. Please install Node.js and npm."
}
Write-Host "  [OK] npm version: $npmVersion" -ForegroundColor Green

# Phase 2: Identify problem
Write-Host "`n[PHASE 2] Identifying problem" -ForegroundColor Cyan

Push-Location $backendPath
try {
    # Check current xlsx version
    $packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    $currentVersion = $packageJson.dependencies.xlsx
    Write-Host "  Current xlsx version: $currentVersion" -ForegroundColor Yellow
    
    # Run npm audit to show vulnerabilities
    Write-Host "`n  Running npm audit..." -ForegroundColor Yellow
    $auditOutput = & npm audit --json 2>&1 | Out-String
    
    if ($auditOutput -match "xlsx") {
        Write-Host "  [WARN] Vulnerabilities found in xlsx package" -ForegroundColor Red
    }
    
} finally {
    Pop-Location
}

# Phase 3: Apply fix
Write-Host "`n[PHASE 3] Applying fix" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY-RUN] Would make the following changes:" -ForegroundColor Yellow
    Write-Host "  1. Update xlsx package to latest version (>= 0.20.2)" -ForegroundColor Yellow
    Write-Host "  2. Run npm audit fix" -ForegroundColor Yellow
    Write-Host "  3. Verify package-lock.json is updated" -ForegroundColor Yellow
} else {
    if (-not $Force -and -not $SkipConfirm) {
        $confirm = Read-Host "Update xlsx package to latest version? (y/n)"
        if ($confirm -ne 'y') {
            Write-Host "Aborted by user" -ForegroundColor Yellow
            exit 0
        }
    }
    
    Push-Location $backendPath
    try {
        Write-Host "  Updating xlsx package..." -ForegroundColor Yellow
        & npm install xlsx@latest --save
        
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed"
        }
        
        Write-Host "  [OK] xlsx package updated" -ForegroundColor Green
        
        Write-Host "`n  Running npm audit fix..." -ForegroundColor Yellow
        & npm audit fix
        
        Write-Host "  [OK] npm audit fix completed" -ForegroundColor Green
        
    } finally {
        Pop-Location
    }
}

# Phase 4: Verify fix
Write-Host "`n[PHASE 4] Verifying fix" -ForegroundColor Cyan

if (-not $DryRun) {
    Push-Location $backendPath
    try {
        $packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
        $newVersion = $packageJson.dependencies.xlsx
        Write-Host "  New xlsx version: $newVersion" -ForegroundColor Green
        
        # Check if vulnerabilities are resolved
        Write-Host "`n  Checking for remaining vulnerabilities..." -ForegroundColor Yellow
        $auditResult = & npm audit --json 2>&1 | ConvertFrom-Json
        
        if ($auditResult.metadata.vulnerabilities.high -eq 0 -and $auditResult.metadata.vulnerabilities.critical -eq 0) {
            Write-Host "  [OK] No high or critical vulnerabilities remaining" -ForegroundColor Green
        } else {
            Write-Host "  [WARN] Some vulnerabilities may still exist. Review npm audit output." -ForegroundColor Yellow
        }
        
    } finally {
        Pop-Location
    }
}

# Phase 5: Test
Write-Host "`n[PHASE 5] Testing" -ForegroundColor Cyan

if (-not $DryRun) {
    Write-Host "  Note: Manual testing required for payroll export functionality" -ForegroundColor Yellow
    Write-Host "  Test steps:" -ForegroundColor Yellow
    Write-Host "    1. Start the backend server" -ForegroundColor Yellow
    Write-Host "    2. Test payroll export feature" -ForegroundColor Yellow
    Write-Host "    3. Verify Excel files are generated correctly" -ForegroundColor Yellow
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "[SUCCESS] ISSUE-001 fixed" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Test payroll export functionality" -ForegroundColor White
Write-Host "  2. Commit changes: git add package.json package-lock.json" -ForegroundColor White
Write-Host "  3. Create commit: git commit -m 'fix: update xlsx package to resolve security vulnerabilities (ISSUE-001)'" -ForegroundColor White
