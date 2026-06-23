<#
.SYNOPSIS
  Fix for ISSUE-007: Missing Rate Limiting on Password Reset

.DESCRIPTION
  Severity: CRITICAL
  Component: Backend - User Management
  Effort: 1 hour
  
  Issue: Password reset endpoint lacks rate limiting, allowing potential abuse
  
  Impact: Account enumeration, potential DoS on email system
  
  Fix: Apply rate limiter to user management routes (5 requests/hour/IP)

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip confirmations

.EXAMPLE
  powershell -File fix-ISSUE-007.ps1 -DryRun
  powershell -File fix-ISSUE-007.ps1 -Force
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
Write-Host "FIX ISSUE-007: Password Reset Rate Limit" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Phase 1: Pre-flight checks
Write-Host "[PHASE 1] Pre-flight checks" -ForegroundColor Cyan

# Check for user routes
$routesDir = "$backendPath/src/routes"
$userRoutesPath = "$routesDir/users.js"

if (Test-Path $userRoutesPath) {
    Write-Host "  [OK] Found user routes: $userRoutesPath" -ForegroundColor Green
} else {
    Write-Host "  [WARN] User routes not found at expected path" -ForegroundColor Yellow
}

# Phase 2: Identify problem
Write-Host "`n[PHASE 2] Identifying problem" -ForegroundColor Cyan

if (Test-Path $userRoutesPath) {
    $userRouteContent = Get-Content $userRoutesPath -Raw
    
    if ($userRouteContent -match "reset-password") {
        Write-Host "  [OK] Password reset endpoint found" -ForegroundColor Yellow
        
        if ($userRouteContent -match "limiter|rateLimit") {
            Write-Host "  [WARN] Some rate limiting may exist" -ForegroundColor Yellow
        } else {
            Write-Host "  [X] No rate limiting on password reset" -ForegroundColor Red
        }
    } else {
        Write-Host "  [WARN] Password reset endpoint not found" -ForegroundColor Yellow
    }
}

# Phase 3: Apply fix
Write-Host "`n[PHASE 3] Applying fix" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY-RUN] Would make the following changes:" -ForegroundColor Yellow
    Write-Host "  1. Create password reset rate limiter (5 req/hour/IP)" -ForegroundColor Yellow
    Write-Host "  2. Apply to password reset endpoints" -ForegroundColor Yellow
    Write-Host "  3. Add logging for rate limit violations" -ForegroundColor Yellow
    Write-Host "  4. Return proper error messages" -ForegroundColor Yellow
} else {
    if (-not $Force -and -not $SkipConfirm) {
        $confirm = Read-Host "Create and apply password reset rate limiter? (y/n)"
        if ($confirm -ne 'y') {
            Write-Host "Aborted by user" -ForegroundColor Yellow
            exit 0
        }
    }
    
    # Create rate limiter configuration
    $rateLimiterPath = "$backendPath/src/middleware/rateLimiters.js"
    $rateLimiterContent = @'
/**
 * Rate Limiters Configuration
 * ISSUE-007 Fix: Password reset and sensitive endpoint rate limiting
 */

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const redis = require('redis');

// Create Redis client for distributed rate limiting (optional)
let redisClient = null;
if (process.env.REDIS_URL) {
  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL,
      legacyMode: false
    });
    redisClient.connect();
    console.log('[OK] Redis connected for rate limiting');
  } catch (error) {
    console.warn('Redis not available, using in-memory rate limiting:', error.message);
  }
}

/**
 * Password Reset Rate Limiter
 * Very strict: 5 requests per hour per IP
 */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour
  message: {
    error: 'Too many password reset attempts. Please try again later.',
    retryAfter: '1 hour'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use Redis store if available
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:password-reset:'
  }) : undefined,
  // Custom key generator (IP + user identifier if available)
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress;
    const userId = req.body?.email || req.params?.id || '';
    return `${ip}-${userId}`;
  },
  // Handler for when limit is exceeded
  handler: (req, res) => {
    console.warn(`[SECURITY] Password reset rate limit exceeded: ${req.ip}`);
    
    // Log to audit system
    if (req.auditLog) {
      req.auditLog({
        event: 'PASSWORD_RESET_RATE_LIMIT',
        severity: 'WARNING',
        ip: req.ip,
        details: 'Too many password reset attempts'
      });
    }
    
    res.status(429).json({
      error: 'Too many password reset attempts',
      message: 'Please try again in 1 hour',
      retryAfter: 3600
    });
  }
});

/**
 * User Management Rate Limiter
 * Moderate: 20 requests per 15 minutes per IP
 */
const userManagementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: {
    error: 'Too many requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:user-mgmt:'
  }) : undefined
});

/**
 * Login Rate Limiter
 * 10 attempts per 15 minutes per IP
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: 'Too many login attempts. Please try again later.'
  },
  skipSuccessfulRequests: true, // Don't count successful logins
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:login:'
  }) : undefined,
  handler: (req, res) => {
    console.warn(`[SECURITY] Login rate limit exceeded: ${req.ip}`);
    
    res.status(429).json({
      error: 'Too many login attempts',
      message: 'Please try again in 15 minutes',
      retryAfter: 900
    });
  }
});

/**
 * Registration Rate Limiter
 * 3 registrations per hour per IP
 */
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: {
    error: 'Too many registration attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:register:'
  }) : undefined
});

/**
 * API General Rate Limiter
 * 100 requests per 15 minutes per IP
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests. Please slow down.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:api:'
  }) : undefined
});

module.exports = {
  passwordResetLimiter,
  userManagementLimiter,
  loginLimiter,
  registrationLimiter,
  apiLimiter
};
'@
    
    $middlewareDir = "$backendPath/src/middleware"
    if (-not (Test-Path $middlewareDir)) {
        New-Item -Path $middlewareDir -ItemType Directory -Force | Out-Null
    }
    
    Set-Content -Path $rateLimiterPath -Value $rateLimiterContent -Encoding UTF8
    Write-Host "  [OK] Rate limiters configuration created" -ForegroundColor Green
    
    Write-Host "`n  Manual integration required:" -ForegroundColor Yellow
    Write-Host "  Apply rate limiters to your routes:" -ForegroundColor Yellow
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // In your user routes file:" -ForegroundColor Cyan
    Write-Host "  const { " -ForegroundColor Cyan
    Write-Host "    passwordResetLimiter, " -ForegroundColor Cyan
    Write-Host "    userManagementLimiter " -ForegroundColor Cyan
    Write-Host "  } = require('../middleware/rateLimiters');" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // Apply to password reset endpoints:" -ForegroundColor Cyan
    Write-Host "  router.post('/reset-password', passwordResetLimiter, authController.resetPassword);" -ForegroundColor Cyan
    Write-Host "  router.put('/users/:id/reset-password', passwordResetLimiter, userController.resetPassword);" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // Apply to other user management endpoints:" -ForegroundColor Cyan
    Write-Host "  router.use('/users', userManagementLimiter);" -ForegroundColor Cyan
}

# Phase 4: Verify fix
Write-Host "`n[PHASE 4] Verifying fix" -ForegroundColor Cyan

if (-not $DryRun) {
    if (Test-Path "$backendPath/src/middleware/rateLimiters.js") {
        Write-Host "  [OK] Rate limiters created" -ForegroundColor Green
    }
}

# Phase 5: Test
Write-Host "`n[PHASE 5] Testing" -ForegroundColor Cyan

Write-Host "  Test scenarios:" -ForegroundColor Yellow
Write-Host "    1. Call password reset 3 times (should succeed)" -ForegroundColor Yellow
Write-Host "    2. Call password reset 6 times (last one should fail)" -ForegroundColor Yellow
Write-Host "    3. Verify 429 status code returned" -ForegroundColor Yellow
Write-Host "    4. Check retry-after header" -ForegroundColor Yellow
Write-Host "    5. Verify rate limits reset after window expires" -ForegroundColor Yellow

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "[SUCCESS] ISSUE-007 fix prepared" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Apply rate limiters to password reset routes" -ForegroundColor White
Write-Host "  2. Test rate limiting behavior" -ForegroundColor White
Write-Host "  3. Monitor for rate limit violations in logs" -ForegroundColor White
Write-Host "  4. Commit: git commit -m 'fix: add rate limiting to password reset (ISSUE-007)'" -ForegroundColor White
