<#
.SYNOPSIS
  Fix for ISSUE-009: Console Logs Expose Sensitive Information

.DESCRIPTION
  Severity: HIGH
  Component: Backend - Multiple Files
  Effort: 1 day
  
  Issue: 29 files contain console.log/error/warn that may log sensitive PHI/tokens
  
  Impact: Potential PHI exposure in application logs
  
  Fix: Replace console.log with proper logger that filters PHI

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip confirmations
#>

[CmdletBinding()]
param([switch]$DryRun, [switch]$Force, [switch]$SkipConfirm)

$ErrorActionPreference = 'Stop'
$backendPath = ".."

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "FIX ISSUE-009: Console Log Sanitization" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "[PHASE 1] Pre-flight checks" -ForegroundColor Cyan

# Find all files with console.log
$filesWithConsole = Get-ChildItem -Path "$backendPath/src" -Recurse -Filter "*.js" | 
    Where-Object { (Get-Content $_.FullName -Raw) -match "console\.(log|error|warn|info)" }

Write-Host "  Found $($filesWithConsole.Count) files with console statements" -ForegroundColor Yellow

Write-Host "`n[PHASE 2] Identifying problem" -ForegroundColor Cyan
Write-Host "  Files needing review:" -ForegroundColor Yellow
$filesWithConsole | ForEach-Object { Write-Host "    - $($_.FullName)" -ForegroundColor Gray }

Write-Host "`n[PHASE 3] Applying fix" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY-RUN] Would create PHI-safe logger utility" -ForegroundColor Yellow
} else {
    if (-not $Force -and -not $SkipConfirm) {
        $confirm = Read-Host "Create PHI-safe logger? (y/n)"
        if ($confirm -ne 'y') { exit 0 }
    }
    
    # Create PHI-safe logger
    $loggerPath = "$backendPath/src/utils/phiSafeLogger.js"
    $loggerContent = @'
/**
 * PHI-Safe Logger - ISSUE-009 Fix
 * Filters sensitive information before logging
 */

const winston = require('winston');

// Sensitive field patterns to redact
const SENSITIVE_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /api[_-]?key/i,
  /ssn/i,
  /social[_-]?security/i,
  /credit[_-]?card/i,
  /patient[_-]?name/i,
  /dob|date[_-]?of[_-]?birth/i,
  /medical[_-]?record/i,
  /diagnosis/i,
  /prescription/i,
  /phone/i,
  /email/i,
  /address/i
];

// Redact sensitive data
function redactSensitiveData(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  const redacted = Array.isArray(obj) ? [] : {};
  
  for (const key in obj) {
    const isSensitive = SENSITIVE_PATTERNS.some(pattern => pattern.test(key));
    
    if (isSensitive) {
      redacted[key] = '[REDACTED]';
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      redacted[key] = redactSensitiveData(obj[key]);
    } else {
      redacted[key] = obj[key];
    }
  }
  
  return redacted;
}

// Create Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const redactedMeta = redactSensitiveData(meta);
          return `${timestamp} ${level}: ${message} ${Object.keys(redactedMeta).length ? JSON.stringify(redactedMeta) : ''}`;
        })
      )
    })
  ]
});

module.exports = logger;
'@
    
    Set-Content -Path $loggerPath -Value $loggerContent -Encoding UTF8
    Write-Host "  [OK] PHI-safe logger created" -ForegroundColor Green
    
    Write-Host "`n  Manual: Replace console.log with logger.info() in all files" -ForegroundColor Yellow
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "[SUCCESS] ISSUE-009 fix prepared" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green
