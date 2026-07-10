#!/usr/bin/env pwsh
# Quick verification script - Run before deploying

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Pre-Deployment Verification" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$allPassed = $true

# 1. Check backend tests
Write-Host "[1/6] Running backend tests..." -ForegroundColor Yellow
Push-Location anot-backend-main
$testOutput = npm test 2>&1 | Out-String
if ($testOutput -match "Tests:.*(\d+) passed") {
    $passed = $matches[1]
    Write-Host "  ✅ $passed tests passed" -ForegroundColor Green
} else {
    Write-Host "  ❌ Tests failed" -ForegroundColor Red
    $allPassed = $false
}
Pop-Location
Write-Host ""

# 2. Check Procfile exists
Write-Host "[2/6] Checking Procfile..." -ForegroundColor Yellow
if (Test-Path "anot-backend-main\Procfile") {
    $procContent = Get-Content "anot-backend-main\Procfile" -Raw
    if ($procContent -match "web:.*npm start") {
        Write-Host "  ✅ Procfile exists with correct content" -ForegroundColor Green
    } else {
        Write-Host "  ⚠️  Procfile exists but content incorrect" -ForegroundColor Yellow
    }
} else {
    Write-Host "  ❌ Procfile missing" -ForegroundColor Red
    $allPassed = $false
}
Write-Host ""

# 3. Check package.json start script
Write-Host "[3/6] Checking package.json start script..." -ForegroundColor Yellow
$packageJson = Get-Content "anot-backend-main\package.json" -Raw | ConvertFrom-Json
if ($packageJson.scripts.start) {
    Write-Host "  ✅ Start script: $($packageJson.scripts.start)" -ForegroundColor Green
} else {
    Write-Host "  ❌ No start script found" -ForegroundColor Red
    $allPassed = $false
}
Write-Host ""

# 4. Check vulnerabilities
Write-Host "[4/6] Checking npm vulnerabilities..." -ForegroundColor Yellow
Push-Location anot-backend-main
$auditJson = npm audit --json 2>&1 | ConvertFrom-Json
$vulnCount = $auditJson.metadata.vulnerabilities.total
if ($vulnCount -eq 0) {
    Write-Host "  ✅ No vulnerabilities found" -ForegroundColor Green
} elseif ($vulnCount -le 3 -and $auditJson.metadata.vulnerabilities.high -eq 0 -and $auditJson.metadata.vulnerabilities.critical -eq 0) {
    Write-Host "  ⚠️  $vulnCount vulnerabilities (acceptable: no high/critical)" -ForegroundColor Yellow
} else {
    Write-Host "  ❌ $vulnCount vulnerabilities (fix recommended)" -ForegroundColor Red
    $allPassed = $false
}
Pop-Location
Write-Host ""

# 5. Check server.js exists
Write-Host "[5/6] Checking server.js exists..." -ForegroundColor Yellow
if (Test-Path "anot-backend-main\src\server.js") {
    Write-Host "  ✅ server.js found at correct location" -ForegroundColor Green
} else {
    Write-Host "  ❌ server.js not found" -ForegroundColor Red
    $allPassed = $false
}
Write-Host ""

# 6. Check .ebextensions
Write-Host "[6/6] Checking EB extensions..." -ForegroundColor Yellow
if (Test-Path "anot-backend-main\.ebextensions") {
    $ebFiles = Get-ChildItem "anot-backend-main\.ebextensions" -File
    Write-Host "  ✅ $($ebFiles.Count) EB extension files found" -ForegroundColor Green
} else {
    Write-Host "  ❌ .ebextensions directory not found" -ForegroundColor Red
    $allPassed = $false
}
Write-Host ""

# Summary
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Verification Summary" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

if ($allPassed) {
    Write-Host "✅ ALL CHECKS PASSED" -ForegroundColor Green
    Write-Host ""
    Write-Host "You are ready to:" -ForegroundColor Cyan
    Write-Host "1. Commit changes: git add . && git commit -F COMMIT_MESSAGE_TEMPLATE.txt" -ForegroundColor White
    Write-Host "2. Push: git push origin main" -ForegroundColor White
    Write-Host "3. Deploy (after v48 rollback): cd anot-backend-main && powershell scripts/deploy-to-eb.ps1" -ForegroundColor White
} else {
    Write-Host "❌ SOME CHECKS FAILED" -ForegroundColor Red
    Write-Host ""
    Write-Host "Fix the issues above before deploying." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan

# Return exit code
if ($allPassed) { exit 0 } else { exit 1 }
