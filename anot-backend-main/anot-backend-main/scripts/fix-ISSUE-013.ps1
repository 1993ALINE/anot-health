<#
.SYNOPSIS
  Fix for ISSUE-013: No Pagination on Large Dataset Queries

.DESCRIPTION
  Severity: HIGH
  Component: Backend - Multiple Controllers
  Effort: 1 day
  
  Issue: Endpoints return all records without pagination
  Impact: Performance degradation, timeouts
  Fix: Add LIMIT/OFFSET pagination to all list endpoints
#>

[CmdletBinding()]
param([switch]$DryRun, [switch]$Force)

$ErrorActionPreference = 'Stop'
$backendPath = ".."

Write-Host "FIX ISSUE-013: Add Pagination" -ForegroundColor Cyan

if (-not $DryRun) {
    Write-Host "Creating pagination middleware..." -ForegroundColor Yellow
    
    $paginationPath = "$backendPath/src/middleware/pagination.js"
    $paginationContent = @'
/**
 * Pagination Middleware - ISSUE-013 Fix
 */

function paginationMiddleware(req, res, next) {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100
  const offset = (page - 1) * limit;
  
  req.pagination = { page, limit, offset };
  next();
}

function paginatedResponse(data, total, req) {
  const { page, limit } = req.pagination;
  const totalPages = Math.ceil(total / limit);
  
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    }
  };
}

module.exports = { paginationMiddleware, paginatedResponse };
'@
    
    $middlewareDir = "$backendPath/src/middleware"
    if (-not (Test-Path $middlewareDir)) { New-Item -Path $middlewareDir -ItemType Directory -Force | Out-Null }
    Set-Content -Path $paginationPath -Value $paginationContent -Encoding UTF8
    Write-Host "  [OK] Pagination middleware created" -ForegroundColor Green
}

Write-Host "`n[SUCCESS] Apply pagination to GET /api/audit, /api/visits, /api/notes" -ForegroundColor Green
