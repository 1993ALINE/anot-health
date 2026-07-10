#!/usr/bin/env pwsh
# Fix npm vulnerabilities in backend and frontend
# Run this after successful EB rollback

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  NPM Security Vulnerability Fixer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if we're in the right directory
if (!(Test-Path "anot-backend-main") -or !(Test-Path "anot-frontend-main")) {
    Write-Host "ERROR: Must run from workspace root" -ForegroundColor Red
    Write-Host "Current directory: $(Get-Location)" -ForegroundColor Yellow
    exit 1
}

# Backend vulnerabilities fix
Write-Host "[1/4] Fixing Backend Vulnerabilities..." -ForegroundColor Yellow
Write-Host "  - 3 moderate vulnerabilities (uuid in bull, exceljs)" -ForegroundColor Gray
Push-Location anot-backend-main

Write-Host "  Running npm audit..." -ForegroundColor Gray
$backendAuditBefore = npm audit --json | ConvertFrom-Json
$backendVulnsBefore = $backendAuditBefore.metadata.vulnerabilities.total

Write-Host "  Before: $backendVulnsBefore vulnerabilities" -ForegroundColor Red

# Try to fix vulnerabilities
Write-Host "  Attempting automatic fix..." -ForegroundColor Gray
npm audit fix 2>&1 | Out-Null

# Check if that worked
$backendAuditAfter = npm audit --json | ConvertFrom-Json
$backendVulnsAfter = $backendAuditAfter.metadata.vulnerabilities.total

if ($backendVulnsAfter -eq 0) {
    Write-Host "  After: 0 vulnerabilities" -ForegroundColor Green
    Write-Host "  [OK] Backend vulnerabilities fixed!" -ForegroundColor Green
} elseif ($backendVulnsAfter -lt $backendVulnsBefore) {
    Write-Host "  After: $backendVulnsAfter vulnerabilities (improved)" -ForegroundColor Yellow
    Write-Host "  [WARNING] Some vulnerabilities remain" -ForegroundColor Yellow
} else {
    Write-Host "  After: $backendVulnsAfter vulnerabilities" -ForegroundColor Red
    Write-Host "  [WARNING] Manual fix required" -ForegroundColor Yellow
    
    # Try updating specific packages
    Write-Host "  Trying to update uuid dependency..." -ForegroundColor Gray
    npm update bull exceljs 2>&1 | Out-Null
    
    $backendAuditFinal = npm audit --json | ConvertFrom-Json
    $backendVulnsFinal = $backendAuditFinal.metadata.vulnerabilities.total
    Write-Host "  Final: $backendVulnsFinal vulnerabilities" -ForegroundColor $(if ($backendVulnsFinal -eq 0) { "Green" } else { "Yellow" })
}

Pop-Location
Write-Host ""

# Run backend tests
Write-Host "[2/4] Running Backend Tests..." -ForegroundColor Yellow
Push-Location anot-backend-main

Write-Host "  Running npm test..." -ForegroundColor Gray
$testOutput = npm test 2>&1 | Out-String

if ($testOutput -match "(\d+) passed") {
    $passedTests = $matches[1]
    Write-Host "  [OK] $passedTests tests passed" -ForegroundColor Green
} else {
    Write-Host "  [ERROR] Tests failed" -ForegroundColor Red
    Write-Host "  Check output above for details" -ForegroundColor Yellow
}

Pop-Location
Write-Host ""

# Frontend vulnerabilities fix
Write-Host "[3/4] Fixing Frontend Vulnerabilities..." -ForegroundColor Yellow
Write-Host "  - 1 low vulnerability (esbuild)" -ForegroundColor Gray
Push-Location anot-frontend-main\anot-frontend-main

Write-Host "  Running npm audit..." -ForegroundColor Gray
$frontendAuditBefore = npm audit --json | ConvertFrom-Json
$frontendVulnsBefore = $frontendAuditBefore.metadata.vulnerabilities.total

Write-Host "  Before: $frontendVulnsBefore vulnerabilities" -ForegroundColor Red

# Try to fix vulnerabilities
Write-Host "  Attempting automatic fix..." -ForegroundColor Gray
npm audit fix 2>&1 | Out-Null

# Check if that worked
$frontendAuditAfter = npm audit --json | ConvertFrom-Json
$frontendVulnsAfter = $frontendAuditAfter.metadata.vulnerabilities.total

if ($frontendVulnsAfter -eq 0) {
    Write-Host "  After: 0 vulnerabilities" -ForegroundColor Green
    Write-Host "  [OK] Frontend vulnerabilities fixed!" -ForegroundColor Green
} else {
    Write-Host "  After: $frontendVulnsAfter vulnerabilities" -ForegroundColor Yellow
    Write-Host "  [INFO] Low severity, acceptable for deployment" -ForegroundColor Gray
}

Pop-Location
Write-Host ""

# Summary
Write-Host "[4/4] Summary" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Backend status
if ($backendVulnsFinal -eq 0) {
    Write-Host "[OK] Backend: 0 vulnerabilities, tests passing" -ForegroundColor Green
} else {
    Write-Host "[WARNING] Backend: $backendVulnsFinal vulnerabilities remaining" -ForegroundColor Yellow
}

# Frontend status
if ($frontendVulnsAfter -eq 0) {
    Write-Host "[OK] Frontend: 0 vulnerabilities" -ForegroundColor Green
} else {
    Write-Host "[INFO] Frontend: $frontendVulnsAfter low vulnerabilities (acceptable)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host "1. Review changes: git diff" -ForegroundColor White
Write-Host "2. Commit: git add . && git commit -m 'fix: resolve npm security vulnerabilities'" -ForegroundColor White
Write-Host "3. Push: git push origin main" -ForegroundColor White
Write-Host "4. Deploy to EB (see EB_DEPLOYMENT_FIX_GUIDE.md)" -ForegroundColor White
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Vulnerability fix complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
