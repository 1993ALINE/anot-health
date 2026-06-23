<#
.SYNOPSIS
  Fix for ISSUE-018: Error Messages Leak Implementation Details

.DESCRIPTION
  Severity: HIGH
  Component: Backend - Error Handling
  Effort: 3-4 hours
  
  Issue: Error messages return database details and stack traces
  Impact: Information disclosure that aids attackers
  Fix: Centralized error handler that sanitizes messages
#>

[CmdletBinding()]
param([switch]$DryRun, [switch]$Force)

$ErrorActionPreference = 'Stop'
$backendPath = ".."

Write-Host "FIX ISSUE-018: Error Message Sanitization" -ForegroundColor Cyan

if (-not $DryRun) {
    Write-Host "Creating error sanitizer..." -ForegroundColor Yellow
    
    $errorHandlerPath = "$backendPath/src/middleware/errorHandler.js"
    $errorHandlerContent = @'
/**
 * Error Handler Middleware - ISSUE-018 Fix
 * Sanitizes error messages in production
 */

function sanitizeError(error) {
  // In production, hide sensitive details
  if (process.env.NODE_ENV === 'production') {
    // Map of safe error messages
    const safeMessages = {
      'VALIDATION_ERROR': 'Invalid input provided',
      'UNAUTHORIZED': 'Authentication required',
      'FORBIDDEN': 'Access denied',
      'NOT_FOUND': 'Resource not found',
      'CONFLICT': 'Resource already exists',
      'INTERNAL_ERROR': 'An unexpected error occurred'
    };
    
    return {
      message: safeMessages[error.code] || 'An error occurred',
      code: error.code || 'INTERNAL_ERROR'
    };
  }
  
  // In development, return full details
  return {
    message: error.message,
    code: error.code,
    stack: error.stack
  };
}

function errorHandler(err, req, res, next) {
  console.error('Error:', err);
  
  const status = err.status || err.statusCode || 500;
  const sanitized = sanitizeError(err);
  
  res.status(status).json({
    error: sanitized.message,
    ...(process.env.NODE_ENV !== 'production' && { details: sanitized })
  });
}

module.exports = errorHandler;
'@
    
    $middlewareDir = "$backendPath/src/middleware"
    if (-not (Test-Path $middlewareDir)) { New-Item -Path $middlewareDir -ItemType Directory -Force | Out-Null }
    Set-Content -Path $errorHandlerPath -Value $errorHandlerContent -Encoding UTF8
    Write-Host "  [OK] Error handler created" -ForegroundColor Green
    Write-Host "`n  Add to server.js: app.use(errorHandler)" -ForegroundColor Yellow
}

Write-Host "`n[SUCCESS] Error sanitization ready" -ForegroundColor Green
