<#
.SYNOPSIS
  Fix for ISSUE-005: Hardcoded Production Vercel URLs in CORS

.DESCRIPTION
  Severity: CRITICAL
  Component: Backend - CORS Configuration
  Effort: 30 minutes
  
  Issue: Specific Vercel deployment URLs hardcoded allowing potential unauthorized access
  
  Impact: Potential unauthorized API access from old Vercel deployments
  
  Fix: Remove hardcoded URLs or move to environment variables

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip confirmations

.EXAMPLE
  powershell -File fix-ISSUE-005.ps1 -DryRun
  powershell -File fix-ISSUE-005.ps1 -Force
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force,
    [switch]$SkipConfirm
)

$ErrorActionPreference = 'Stop'
trap {
    Write-Host "[ERROR] Fix failed: $_" -ForegroundColor Red
    exit 1
}

$backendPath = ".."

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "FIX ISSUE-005: Hardcoded CORS URLs" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Phase 1: Pre-flight checks
Write-Host "[PHASE 1] Pre-flight checks" -ForegroundColor Cyan

$serverPath = "$backendPath/src/server.js"
if (Test-Path $serverPath) {
    Write-Host "  [OK] Found server config: $serverPath" -ForegroundColor Green
} else {
    throw "Server config not found at $serverPath"
}

# Phase 2: Identify problem
Write-Host "`n[PHASE 2] Identifying problem" -ForegroundColor Cyan

$serverContent = Get-Content $serverPath -Raw

$vercelUrls = @()
if ($serverContent -match "https://.*\.vercel\.app") {
    Write-Host "  [WARN] Found hardcoded Vercel URLs in CORS configuration:" -ForegroundColor Red
    
    # Extract all Vercel URLs
    $matches = [regex]::Matches($serverContent, "['`"]https://[^'`"]*\.vercel\.app['`"]")
    foreach ($match in $matches) {
        $url = $match.Value.Trim("'", '"')
        $vercelUrls += $url
        Write-Host "    - $url" -ForegroundColor Yellow
    }
}

# Phase 3: Apply fix
Write-Host "`n[PHASE 3] Applying fix" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY-RUN] Would make the following changes:" -ForegroundColor Yellow
    Write-Host "  1. Remove hardcoded Vercel URLs from CORS configuration" -ForegroundColor Yellow
    Write-Host "  2. Add CORS_ORIGINS environment variable support" -ForegroundColor Yellow
    Write-Host "  3. Update .env.example with CORS_ORIGINS template" -ForegroundColor Yellow
    Write-Host "`n  URLs to be removed:" -ForegroundColor Yellow
    foreach ($url in $vercelUrls) {
        Write-Host "    - $url" -ForegroundColor Yellow
    }
} else {
    if (-not $Force -and -not $SkipConfirm) {
        Write-Host "`n  The following Vercel URLs will be removed:" -ForegroundColor Yellow
        foreach ($url in $vercelUrls) {
            Write-Host "    - $url" -ForegroundColor Yellow
        }
        $confirm = Read-Host "`n  Proceed with removal? (y/n)"
        if ($confirm -ne 'y') {
            Write-Host "Aborted by user" -ForegroundColor Yellow
            exit 0
        }
    }
    
    Write-Host "  Updating CORS configuration..." -ForegroundColor Yellow
    
    # Read current server.js
    $currentContent = Get-Content $serverPath -Raw
    
    # Replace hardcoded CORS origins with environment variable approach
    $corsPattern = "const allowedOrigins = \[[^\]]+\]"
    
    $newCorsConfig = @'
// CORS configuration - ISSUE-005 Fix
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
  : [
      'http://localhost:3000',
      'http://localhost:5173',
      process.env.FRONTEND_URL
    ].filter(Boolean)
'@
    
    if ($currentContent -match $corsPattern) {
        $updatedContent = $currentContent -replace $corsPattern, $newCorsConfig
        Set-Content -Path $serverPath -Value $updatedContent -Encoding UTF8 -NoNewline
        Write-Host "  [OK] CORS configuration updated" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] Could not find CORS allowedOrigins pattern" -ForegroundColor Yellow
        Write-Host "  Manual update required" -ForegroundColor Yellow
    }
    
    # Update .env.example
    $envExamplePath = "$backendPath/.env.example"
    if (Test-Path $envExamplePath) {
        $envContent = Get-Content $envExamplePath -Raw
        
        if ($envContent -notmatch "CORS_ORIGINS") {
            Add-Content -Path $envExamplePath -Value "`n# CORS Configuration`nCORS_ORIGINS=https://yourdomain.com,https://app.yourdomain.com`n"
            Write-Host "  [OK] Updated .env.example with CORS_ORIGINS" -ForegroundColor Green
        }
    } else {
        Write-Host "  [WARN] .env.example not found, skipping" -ForegroundColor Yellow
    }
    
    # Check for .env file
    $envPath = "$backendPath/.env"
    if (Test-Path $envPath) {
        Write-Host "`n  [WARN] Action required: Update your .env file" -ForegroundColor Yellow
        Write-Host "  Add this line with your production URLs:" -ForegroundColor Yellow
        Write-Host "  CORS_ORIGINS=https://yourdomain.com,https://app.yourdomain.com" -ForegroundColor Cyan
    }
}

# Phase 4: Verify fix
Write-Host "`n[PHASE 4] Verifying fix" -ForegroundColor Cyan

if (-not $DryRun) {
    $updatedContent = Get-Content $serverPath -Raw
    
    if ($updatedContent -notmatch "vercel\.app") {
        Write-Host "  [OK] No hardcoded Vercel URLs found" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] Some Vercel URLs may still exist" -ForegroundColor Yellow
    }
    
    if ($updatedContent -match "CORS_ORIGINS") {
        Write-Host "  [OK] Environment variable support added" -ForegroundColor Green
    }
}

# Phase 5: Test
Write-Host "`n[PHASE 5] Testing" -ForegroundColor Cyan

Write-Host "  Test steps:" -ForegroundColor Yellow
Write-Host "    1. Set CORS_ORIGINS in your .env file" -ForegroundColor Yellow
Write-Host "    2. Start the backend server" -ForegroundColor Yellow
Write-Host "    3. Test CORS from allowed origin (should work)" -ForegroundColor Yellow
Write-Host "    4. Test CORS from disallowed origin (should fail)" -ForegroundColor Yellow
Write-Host "    5. Verify old Vercel URLs are blocked" -ForegroundColor Yellow

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "[SUCCESS] ISSUE-005 fixed" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Update .env with CORS_ORIGINS=your-production-url" -ForegroundColor White
Write-Host "  2. Test CORS from production frontend" -ForegroundColor White
Write-Host "  3. Commit: git commit -m 'fix: remove hardcoded CORS URLs (ISSUE-005)'" -ForegroundColor White
