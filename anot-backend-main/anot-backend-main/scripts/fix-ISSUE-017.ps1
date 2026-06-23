<#
.SYNOPSIS
  Fix for ISSUE-017: Database Query Performance Issues

.DESCRIPTION
  Severity: HIGH
  Component: Backend - Database Queries
  Effort: 4 hours
  
  Issue: Missing indexes on frequently queried columns
  Impact: Degraded performance as data grows
  Fix: Add indexes to audit logs and other tables
#>

[CmdletBinding()]
param([switch]$DryRun, [switch]$Force)

$ErrorActionPreference = 'Stop'
$backendPath = ".."

Write-Host "FIX ISSUE-017: Database Performance" -ForegroundColor Cyan

if (-not $DryRun) {
    Write-Host "Creating database optimization script..." -ForegroundColor Yellow
    
    $dbOptimizationPath = "$backendPath/scripts/optimize-database.sql"
    $dbOptimizationContent = @'
-- Database Performance Optimization - ISSUE-017 Fix
-- Add indexes for frequently queried columns

-- Audit logs indexes
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON audit_logs(severity);

-- Visits indexes
CREATE INDEX IF NOT EXISTS idx_visits_patient_id ON visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_clinician_id ON visits(clinician_id);
CREATE INDEX IF NOT EXISTS idx_visits_created_at ON visits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);

-- Notes indexes
CREATE INDEX IF NOT EXISTS idx_notes_visit_id ON notes(visit_id);
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);

-- Users indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Audio files indexes
CREATE INDEX IF NOT EXISTS idx_audio_files_user_id ON audio_files(user_id);
CREATE INDEX IF NOT EXISTS idx_audio_files_status ON audio_files(status);

ANALYZE;
'@
    
    $scriptsDir = "$backendPath/scripts"
    if (-not (Test-Path $scriptsDir)) { New-Item -Path $scriptsDir -ItemType Directory -Force | Out-Null }
    Set-Content -Path $dbOptimizationPath -Value $dbOptimizationContent -Encoding UTF8
    Write-Host "  [OK] Database optimization SQL created" -ForegroundColor Green
    Write-Host "`n  Run: psql -U user -d database -f optimize-database.sql" -ForegroundColor Yellow
}

Write-Host "`n[SUCCESS] Database optimization script ready" -ForegroundColor Green
