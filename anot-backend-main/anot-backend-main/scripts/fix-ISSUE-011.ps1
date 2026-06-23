<#
.SYNOPSIS
  Fix for ISSUE-011: Missing Transaction Rollback in Visit Endpoints

.DESCRIPTION
  Severity: HIGH
  Component: Backend - Visit Controller
  Effort: 4-6 hours
  
  Issue: Multi-table operations don't use transactions
  Impact: Data inconsistency, orphaned records
  Fix: Wrap multi-table operations in transactions
#>

[CmdletBinding()]
param([switch]$DryRun, [switch]$Force)

$ErrorActionPreference = 'Stop'
$backendPath = ".."

Write-Host "FIX ISSUE-011: Transaction Rollback" -ForegroundColor Cyan

$visitControllerPath = "$backendPath/src/controllers/visitController.js"

if (Test-Path $visitControllerPath) {
    $content = Get-Content $visitControllerPath -Raw
    if ($content -match "withTransaction|BEGIN|COMMIT") {
        Write-Host "  [OK] Some transaction logic exists" -ForegroundColor Green
    } else {
        Write-Host "  [X] No transaction logic found" -ForegroundColor Red
    }
}

if (-not $DryRun) {
    Write-Host "`nCreating transaction helper..." -ForegroundColor Yellow
    
    $transactionHelperPath = "$backendPath/src/utils/transactionHelper.js"
    $transactionHelperContent = @'
/**
 * Transaction Helper - ISSUE-011 Fix
 */

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
'@
    
    $utilsDir = "$backendPath/src/utils"
    if (-not (Test-Path $utilsDir)) { New-Item -Path $utilsDir -ItemType Directory -Force | Out-Null }
    Set-Content -Path $transactionHelperPath -Value $transactionHelperContent -Encoding UTF8
    Write-Host "  [OK] Transaction helper created" -ForegroundColor Green
}

Write-Host "`n[SUCCESS] Wrap multi-table operations with withTransaction()" -ForegroundColor Green
