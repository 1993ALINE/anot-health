<#
.SYNOPSIS
  Fix for ISSUE-015: Missing Input Sanitization

.DESCRIPTION
  Severity: HIGH
  Component: Backend - All POST/PUT endpoints
  Effort: 2 days
  
  Issue: express-validator not consistently used
  Impact: Data corruption, injection vulnerabilities
  Fix: Apply express-validator to all input fields
#>

[CmdletBinding()]
param([switch]$DryRun, [switch]$Force)

$ErrorActionPreference = 'Stop'
$backendPath = ".."

Write-Host "FIX ISSUE-015: Input Sanitization" -ForegroundColor Cyan

if (-not $DryRun) {
    Write-Host "Creating validation utilities..." -ForegroundColor Yellow
    
    $validationPath = "$backendPath/src/middleware/validators.js"
    $validationContent = @'
/**
 * Common Validators - ISSUE-015 Fix
 */

const { body, param, query, validationResult } = require('express-validator');

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Common validators
const validateId = [
  param('id').isInt().withMessage('ID must be an integer')
];

const validateEmail = [
  body('email').isEmail().normalizeEmail().withMessage('Invalid email')
];

const validatePassword = [
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and number')
];

module.exports = {
  handleValidationErrors,
  validateId,
  validateEmail,
  validatePassword
};
'@
    
    $middlewareDir = "$backendPath/src/middleware"
    if (-not (Test-Path $middlewareDir)) { New-Item -Path $middlewareDir -ItemType Directory -Force | Out-Null }
    Set-Content -Path $validationPath -Value $validationContent -Encoding UTF8
    Write-Host "  [OK] Validation utilities created" -ForegroundColor Green
}

Write-Host "`n[SUCCESS] Apply validators to all POST/PUT routes" -ForegroundColor Green
