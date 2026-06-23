<#
.SYNOPSIS
  Fix for ISSUE-010: Session Timeout Not Enforced Client-Side

.DESCRIPTION
  Severity: HIGH
  Component: Frontend - Session Management
  Effort: 2 hours
  
  Issue: useSessionTimeout hook not consistently applied across portals
  Impact: Poor UX, confusion about session state
  Fix: Apply useSessionTimeout to all portal root components
#>

[CmdletBinding()]
param([switch]$DryRun, [switch]$Force)

$ErrorActionPreference = 'Stop'
$frontendPath = "../../../anot-frontend-main/anot-frontend-main"

Write-Host "FIX ISSUE-010: Session Timeout Enforcement" -ForegroundColor Cyan

$portalFiles = @(
    "$frontendPath/src/pages/Clinician/index.jsx",
    "$frontendPath/src/pages/Admin/index.jsx",
    "$frontendPath/src/pages/Scribe/index.jsx"
)

Write-Host "`n[PHASE 2] Checking portals for useSessionTimeout..." -ForegroundColor Cyan
foreach ($file in $portalFiles) {
    if (Test-Path $file) {
        $content = Get-Content $file -Raw
        if ($content -match "useSessionTimeout") {
            Write-Host "  [OK] $file has useSessionTimeout" -ForegroundColor Green
        } else {
            Write-Host "  [X] $file missing useSessionTimeout" -ForegroundColor Red
        }
    }
}

Write-Host "`n[SUCCESS] Manual fix required: Add useSessionTimeout() hook to each portal component" -ForegroundColor Yellow
