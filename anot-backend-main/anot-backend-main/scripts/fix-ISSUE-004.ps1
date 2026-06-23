<#
.SYNOPSIS
  Fix for ISSUE-004: Missing Database Connection Pool Error Recovery

.DESCRIPTION
  Severity: CRITICAL
  Component: Backend - Database Configuration
  Effort: 4-6 hours
  
  Issue: No automatic retry logic for failed connections during high load or network issues
  
  Impact: Application becomes unresponsive during database connectivity issues
  
  Fix: Implement connection retry with exponential backoff and circuit breaker

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip confirmations

.EXAMPLE
  powershell -File fix-ISSUE-004.ps1 -DryRun
  powershell -File fix-ISSUE-004.ps1 -Force
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
Write-Host "FIX ISSUE-004: DB Connection Recovery" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Phase 1: Pre-flight checks
Write-Host "[PHASE 1] Pre-flight checks" -ForegroundColor Cyan

$dbConfigPath = "$backendPath/src/config/db.js"
if (Test-Path $dbConfigPath) {
    Write-Host "  [OK] Found database config: $dbConfigPath" -ForegroundColor Green
} else {
    throw "Database config not found at $dbConfigPath"
}

# Phase 2: Identify problem
Write-Host "`n[PHASE 2] Identifying problem" -ForegroundColor Cyan

$dbContent = Get-Content $dbConfigPath -Raw

if ($dbContent -match "pool\.on\('error'") {
    Write-Host "  [OK] Error handler exists" -ForegroundColor Green
} else {
    Write-Host "  [X] No error handler found" -ForegroundColor Red
}

if ($dbContent -match "retry|reconnect|exponential") {
    Write-Host "  [OK] Retry logic may exist" -ForegroundColor Green
} else {
    Write-Host "  [X] No retry logic found" -ForegroundColor Red
}

# Phase 3: Apply fix
Write-Host "`n[PHASE 3] Applying fix" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY-RUN] Would make the following changes:" -ForegroundColor Yellow
    Write-Host "  1. Add exponential backoff retry logic" -ForegroundColor Yellow
    Write-Host "  2. Implement connection health checks" -ForegroundColor Yellow
    Write-Host "  3. Add circuit breaker pattern" -ForegroundColor Yellow
    Write-Host "  4. Improve error handling and logging" -ForegroundColor Yellow
} else {
    if (-not $Force -and -not $SkipConfirm) {
        $confirm = Read-Host "Update database configuration with retry logic? (y/n)"
        if ($confirm -ne 'y') {
            Write-Host "Aborted by user" -ForegroundColor Yellow
            exit 0
        }
    }
    
    # Create enhanced database connection manager
    $dbUtilPath = "$backendPath/src/utils/dbConnection.js"
    $dbUtilContent = @'
/**
 * Database Connection Manager with Retry Logic
 * ISSUE-004 Fix: Enhanced connection recovery and resilience
 */

const { Pool } = require('pg');

class DatabaseConnectionManager {
  constructor(config) {
    this.config = config;
    this.pool = null;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.retryDelay = 1000; // Start with 1 second
    this.maxRetryDelay = 30000; // Max 30 seconds
    this.isConnecting = false;
    this.circuitBreakerOpen = false;
    this.circuitBreakerTimeout = null;
  }

  /**
   * Calculate exponential backoff delay
   */
  getBackoffDelay() {
    const delay = Math.min(
      this.retryDelay * Math.pow(2, this.retryCount),
      this.maxRetryDelay
    );
    // Add jitter to prevent thundering herd
    return delay + Math.random() * 1000;
  }

  /**
   * Initialize database connection pool
   */
  async initialize() {
    try {
      console.log('Initializing database connection pool...');
      
      this.pool = new Pool({
        ...this.config,
        // Connection pool settings
        max: 20, // Maximum connections
        min: 2, // Minimum connections
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        
        // Retry settings
        allowExitOnIdle: false
      });

      // Handle pool errors
      this.pool.on('error', (err, client) => {
        console.error('Unexpected database pool error:', err);
        this.handlePoolError(err);
      });

      // Handle client connect
      this.pool.on('connect', (client) => {
        console.log('New database client connected');
        this.retryCount = 0; // Reset retry count on successful connection
        this.circuitBreakerOpen = false;
      });

      // Handle client removal
      this.pool.on('remove', (client) => {
        console.log('Database client removed from pool');
      });

      // Test initial connection
      await this.testConnection();
      
      console.log('[OK] Database connection pool initialized successfully');
      return this.pool;
    } catch (error) {
      console.error('Failed to initialize database connection:', error);
      throw error;
    }
  }

  /**
   * Test database connection
   */
  async testConnection() {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT NOW()');
      console.log('[OK] Database connection test successful');
      return true;
    } finally {
      client.release();
    }
  }

  /**
   * Handle pool errors and trigger reconnection
   */
  async handlePoolError(error) {
    if (this.isConnecting || this.circuitBreakerOpen) {
      return; // Already attempting reconnection or circuit breaker is open
    }

    console.error('Database connection error, attempting recovery...');
    await this.reconnectWithRetry();
  }

  /**
   * Reconnect with exponential backoff
   */
  async reconnectWithRetry() {
    if (this.retryCount >= this.maxRetries) {
      console.error('Max retry attempts reached. Opening circuit breaker.');
      this.openCircuitBreaker();
      return;
    }

    this.isConnecting = true;
    this.retryCount++;

    const delay = this.getBackoffDelay();
    console.log(`Retry attempt ${this.retryCount}/${this.maxRetries} after ${Math.round(delay)}ms...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.testConnection();
      console.log('[OK] Database reconnection successful');
      this.retryCount = 0;
      this.isConnecting = false;
    } catch (error) {
      console.error(`Reconnection attempt ${this.retryCount} failed:`, error.message);
      this.isConnecting = false;
      await this.reconnectWithRetry();
    }
  }

  /**
   * Open circuit breaker (stop trying to reconnect temporarily)
   */
  openCircuitBreaker() {
    this.circuitBreakerOpen = true;
    console.log('Circuit breaker opened. Waiting 60s before retry...');
    
    // Clear existing timeout
    if (this.circuitBreakerTimeout) {
      clearTimeout(this.circuitBreakerTimeout);
    }
    
    // Close circuit breaker after 60 seconds
    this.circuitBreakerTimeout = setTimeout(() => {
      console.log('Circuit breaker closed. Retrying connection...');
      this.circuitBreakerOpen = false;
      this.retryCount = 0;
      this.reconnectWithRetry();
    }, 60000);
  }

  /**
   * Execute query with automatic retry
   */
  async query(text, params) {
    const maxAttempts = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.pool.query(text, params);
      } catch (error) {
        lastError = error;
        
        // Check if error is recoverable
        if (this.isRecoverableError(error) && attempt < maxAttempts) {
          console.warn(`Query failed (attempt ${attempt}/${maxAttempts}), retrying...`);
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
          continue;
        }
        
        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Check if error is recoverable
   */
  isRecoverableError(error) {
    const recoverableCodes = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      '57P01', // PostgreSQL admin shutdown
      '57P02', // PostgreSQL crash shutdown
      '57P03', // PostgreSQL cannot connect now
      '08006', // Connection failure
      '08003', // Connection does not exist
      '08000'  // Connection exception
    ];

    return recoverableCodes.some(code => 
      error.code === code || error.message.includes(code)
    );
  }

  /**
   * Get pool instance
   */
  getPool() {
    if (!this.pool) {
      throw new Error('Database pool not initialized');
    }
    return this.pool;
  }

  /**
   * Graceful shutdown
   */
  async close() {
    if (this.circuitBreakerTimeout) {
      clearTimeout(this.circuitBreakerTimeout);
    }

    if (this.pool) {
      console.log('Closing database connection pool...');
      await this.pool.end();
      console.log('[OK] Database connection pool closed');
    }
  }
}

module.exports = DatabaseConnectionManager;
'@
    
    $utilsDir = "$backendPath/src/utils"
    if (-not (Test-Path $utilsDir)) {
        New-Item -Path $utilsDir -ItemType Directory -Force | Out-Null
    }
    
    Set-Content -Path $dbUtilPath -Value $dbUtilContent -Encoding UTF8
    Write-Host "  [OK] Database connection manager created" -ForegroundColor Green
    
    Write-Host "`n  Manual update required:" -ForegroundColor Yellow
    Write-Host "  Update src/config/db.js to use the new connection manager:" -ForegroundColor Yellow
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  const DatabaseConnectionManager = require('../utils/dbConnection');" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  const dbManager = new DatabaseConnectionManager({" -ForegroundColor Cyan
    Write-Host "    host: process.env.DB_HOST," -ForegroundColor Cyan
    Write-Host "    port: process.env.DB_PORT," -ForegroundColor Cyan
    Write-Host "    database: process.env.DB_NAME," -ForegroundColor Cyan
    Write-Host "    user: process.env.DB_USER," -ForegroundColor Cyan
    Write-Host "    password: process.env.DB_PASSWORD," -ForegroundColor Cyan
    Write-Host "    ssl: { rejectUnauthorized: false }" -ForegroundColor Cyan
    Write-Host "  });" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // Initialize on startup" -ForegroundColor Cyan
    Write-Host "  await dbManager.initialize();" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // Export pool and manager" -ForegroundColor Cyan
    Write-Host "  module.exports = {" -ForegroundColor Cyan
    Write-Host "    pool: dbManager.getPool()," -ForegroundColor Cyan
    Write-Host "    dbManager," -ForegroundColor Cyan
    Write-Host "    query: (text, params) => dbManager.query(text, params)" -ForegroundColor Cyan
    Write-Host "  };" -ForegroundColor Cyan
}

# Phase 4: Verify fix
Write-Host "`n[PHASE 4] Verifying fix" -ForegroundColor Cyan

if (-not $DryRun) {
    if (Test-Path "$backendPath/src/utils/dbConnection.js") {
        Write-Host "  [OK] Database connection manager created" -ForegroundColor Green
    }
}

# Phase 5: Test
Write-Host "`n[PHASE 5] Testing" -ForegroundColor Cyan

Write-Host "  Test scenarios:" -ForegroundColor Yellow
Write-Host "    1. Normal operations (should work)" -ForegroundColor Yellow
Write-Host "    2. Simulate network interruption (should retry)" -ForegroundColor Yellow
Write-Host "    3. Simulate database restart (should reconnect)" -ForegroundColor Yellow
Write-Host "    4. Monitor logs for retry attempts" -ForegroundColor Yellow

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "[SUCCESS] ISSUE-004 fix prepared" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Update db.js to use new connection manager" -ForegroundColor White
Write-Host "  2. Test connection recovery scenarios" -ForegroundColor White
Write-Host "  3. Commit: git commit -m 'fix: add database connection retry logic (ISSUE-004)'" -ForegroundColor White
