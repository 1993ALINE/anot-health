<#
.SYNOPSIS
  Fix for ISSUE-008: CloudWatch Logging Configuration Incomplete

.DESCRIPTION
  Severity: CRITICAL
  Component: Backend - Audit Logging
  Effort: 2 hours
  
  Issue: CloudWatch logging may fail silently if AWS credentials are misconfigured
  
  Impact: Loss of audit trail required for HIPAA compliance
  
  Fix: Make CloudWatch initialization mandatory in production, add health checks

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip confirmations

.EXAMPLE
  powershell -File fix-ISSUE-008.ps1 -DryRun
  powershell -File fix-ISSUE-008.ps1 -Force
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
Write-Host "FIX ISSUE-008: CloudWatch Logging" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Phase 1: Pre-flight checks
Write-Host "[PHASE 1] Pre-flight checks" -ForegroundColor Cyan

$serverPath = "$backendPath/src/server.js"
if (Test-Path $serverPath) {
    Write-Host "  [OK] Found server.js: $serverPath" -ForegroundColor Green
} else {
    throw "Server config not found at $serverPath"
}

# Phase 2: Identify problem
Write-Host "`n[PHASE 2] Identifying problem" -ForegroundColor Cyan

$serverContent = Get-Content $serverPath -Raw

if ($serverContent -match "initCloudWatch|CloudWatch") {
    Write-Host "  [OK] CloudWatch initialization found" -ForegroundColor Yellow
    
    if ($serverContent -match "catch.*initCloudWatch") {
        Write-Host "  [WARN] CloudWatch errors are caught (may fail silently)" -ForegroundColor Red
    }
} else {
    Write-Host "  [WARN] No CloudWatch initialization found" -ForegroundColor Yellow
}

# Phase 3: Apply fix
Write-Host "`n[PHASE 3] Applying fix" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY-RUN] Would make the following changes:" -ForegroundColor Yellow
    Write-Host "  1. Make CloudWatch init mandatory in production" -ForegroundColor Yellow
    Write-Host "  2. Add CloudWatch health check endpoint" -ForegroundColor Yellow
    Write-Host "  3. Verify log streams are created" -ForegroundColor Yellow
    Write-Host "  4. Add startup validation" -ForegroundColor Yellow
} else {
    if (-not $Force -and -not $SkipConfirm) {
        $confirm = Read-Host "Update CloudWatch configuration for strict validation? (y/n)"
        if ($confirm -ne 'y') {
            Write-Host "Aborted by user" -ForegroundColor Yellow
            exit 0
        }
    }
    
    # Create CloudWatch validator
    $cwValidatorPath = "$backendPath/src/utils/cloudWatchValidator.js"
    $cwValidatorContent = @'
/**
 * CloudWatch Logging Validator
 * ISSUE-008 Fix: Ensure CloudWatch logging is operational in production
 */

const AWS = require('aws-sdk');

class CloudWatchValidator {
  constructor() {
    this.cloudWatchLogs = new AWS.CloudWatchLogs({
      region: process.env.AWS_REGION || 'us-east-1'
    });
    
    this.logGroupName = process.env.CLOUDWATCH_LOG_GROUP || '/aws/anot-health/application';
    this.logStreamName = process.env.CLOUDWATCH_LOG_STREAM || `app-${process.env.NODE_ENV}-${Date.now()}`;
    this.isValidated = false;
    this.lastHealthCheck = null;
  }

  /**
   * Validate CloudWatch configuration
   */
  async validate() {
    console.log('Validating CloudWatch configuration...');
    
    try {
      // Step 1: Check AWS credentials
      await this.checkCredentials();
      
      // Step 2: Check log group exists
      await this.checkLogGroup();
      
      // Step 3: Check/create log stream
      await this.checkLogStream();
      
      // Step 4: Test writing a log
      await this.testWrite();
      
      this.isValidated = true;
      this.lastHealthCheck = new Date();
      
      console.log('[OK] CloudWatch validation successful');
      return true;
    } catch (error) {
      console.error('[X] CloudWatch validation failed:', error);
      
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`CloudWatch validation failed in production: ${error.message}`);
      }
      
      console.warn('CloudWatch validation failed in non-production environment - continuing');
      return false;
    }
  }

  /**
   * Check AWS credentials are valid
   */
  async checkCredentials() {
    console.log('  Checking AWS credentials...');
    
    const sts = new AWS.STS();
    
    try {
      const identity = await sts.getCallerIdentity().promise();
      console.log(`  [OK] AWS credentials valid (Account: ${identity.Account})`);
      return true;
    } catch (error) {
      throw new Error(`Invalid AWS credentials: ${error.message}`);
    }
  }

  /**
   * Check log group exists, create if needed
   */
  async checkLogGroup() {
    console.log(`  Checking log group: ${this.logGroupName}...`);
    
    try {
      const result = await this.cloudWatchLogs.describeLogGroups({
        logGroupNamePrefix: this.logGroupName
      }).promise();
      
      const exists = result.logGroups?.some(lg => lg.logGroupName === this.logGroupName);
      
      if (!exists) {
        console.log('  Log group not found, creating...');
        await this.cloudWatchLogs.createLogGroup({
          logGroupName: this.logGroupName
        }).promise();
        
        // Set retention policy (6 years for HIPAA compliance)
        await this.cloudWatchLogs.putRetentionPolicy({
          logGroupName: this.logGroupName,
          retentionInDays: 2192 // ~6 years
        }).promise();
        
        console.log('  [OK] Log group created with 6-year retention');
      } else {
        console.log('  [OK] Log group exists');
      }
      
      return true;
    } catch (error) {
      throw new Error(`Log group check failed: ${error.message}`);
    }
  }

  /**
   * Check log stream exists, create if needed
   */
  async checkLogStream() {
    console.log(`  Checking log stream: ${this.logStreamName}...`);
    
    try {
      const result = await this.cloudWatchLogs.describeLogStreams({
        logGroupName: this.logGroupName,
        logStreamNamePrefix: this.logStreamName
      }).promise();
      
      const exists = result.logStreams?.some(ls => ls.logStreamName === this.logStreamName);
      
      if (!exists) {
        console.log('  Log stream not found, creating...');
        await this.cloudWatchLogs.createLogStream({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName
        }).promise();
        console.log('  [OK] Log stream created');
      } else {
        console.log('  [OK] Log stream exists');
      }
      
      return true;
    } catch (error) {
      throw new Error(`Log stream check failed: ${error.message}`);
    }
  }

  /**
   * Test writing a log event
   */
  async testWrite() {
    console.log('  Testing CloudWatch write...');
    
    try {
      await this.cloudWatchLogs.putLogEvents({
        logGroupName: this.logGroupName,
        logStreamName: this.logStreamName,
        logEvents: [{
          message: JSON.stringify({
            event: 'CLOUDWATCH_VALIDATION',
            timestamp: new Date().toISOString(),
            message: 'CloudWatch logging validation successful'
          }),
          timestamp: Date.now()
        }]
      }).promise();
      
      console.log('  [OK] CloudWatch write test successful');
      return true;
    } catch (error) {
      throw new Error(`CloudWatch write test failed: ${error.message}`);
    }
  }

  /**
   * Health check for CloudWatch logging
   */
  async healthCheck() {
    try {
      // Re-validate every 5 minutes
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      
      if (!this.lastHealthCheck || this.lastHealthCheck < fiveMinutesAgo) {
        await this.validate();
      }
      
      return {
        status: 'healthy',
        validated: this.isValidated,
        lastCheck: this.lastHealthCheck,
        logGroup: this.logGroupName,
        logStream: this.logStreamName
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        validated: false
      };
    }
  }

  /**
   * Get validator status
   */
  getStatus() {
    return {
      validated: this.isValidated,
      lastHealthCheck: this.lastHealthCheck,
      logGroupName: this.logGroupName,
      logStreamName: this.logStreamName
    };
  }
}

module.exports = CloudWatchValidator;
'@
    
    $utilsDir = "$backendPath/src/utils"
    if (-not (Test-Path $utilsDir)) {
        New-Item -Path $utilsDir -ItemType Directory -Force | Out-Null
    }
    
    Set-Content -Path $cwValidatorPath -Value $cwValidatorContent -Encoding UTF8
    Write-Host "  [OK] CloudWatch validator created" -ForegroundColor Green
    
    Write-Host "`n  Manual integration required:" -ForegroundColor Yellow
    Write-Host "  Update server.js startup:" -ForegroundColor Yellow
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  const CloudWatchValidator = require('./utils/cloudWatchValidator');" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // Initialize CloudWatch validator" -ForegroundColor Cyan
    Write-Host "  const cwValidator = new CloudWatchValidator();" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // In production, validation MUST succeed" -ForegroundColor Cyan
    Write-Host "  if (process.env.NODE_ENV === 'production') {" -ForegroundColor Cyan
    Write-Host "    await cwValidator.validate(); // This will throw if validation fails" -ForegroundColor Cyan
    Write-Host "  } else {" -ForegroundColor Cyan
    Write-Host "    await cwValidator.validate().catch(err => {" -ForegroundColor Cyan
    Write-Host "      console.warn('CloudWatch validation failed (non-prod):', err.message);" -ForegroundColor Cyan
    Write-Host "    });" -ForegroundColor Cyan
    Write-Host "  }" -ForegroundColor Cyan
    Write-Host "  " -ForegroundColor Cyan
    Write-Host "  // Add health check endpoint" -ForegroundColor Cyan
    Write-Host "  app.get('/api/admin/health/cloudwatch', async (req, res) => {" -ForegroundColor Cyan
    Write-Host "    const health = await cwValidator.healthCheck();" -ForegroundColor Cyan
    Write-Host "    res.status(health.status === 'healthy' ? 200 : 503).json(health);" -ForegroundColor Cyan
    Write-Host "  });" -ForegroundColor Cyan
}

# Phase 4: Verify fix
Write-Host "`n[PHASE 4] Verifying fix" -ForegroundColor Cyan

if (-not $DryRun) {
    if (Test-Path "$backendPath/src/utils/cloudWatchValidator.js") {
        Write-Host "  [OK] CloudWatch validator created" -ForegroundColor Green
    }
    
    Write-Host "`n  Environment variables needed:" -ForegroundColor Yellow
    Write-Host "    AWS_REGION=us-east-1" -ForegroundColor Yellow
    Write-Host "    AWS_ACCESS_KEY_ID=..." -ForegroundColor Yellow
    Write-Host "    AWS_SECRET_ACCESS_KEY=..." -ForegroundColor Yellow
    Write-Host "    CLOUDWATCH_LOG_GROUP=/aws/anot-health/application" -ForegroundColor Yellow
}

# Phase 5: Test
Write-Host "`n[PHASE 5] Testing" -ForegroundColor Cyan

Write-Host "  Test scenarios:" -ForegroundColor Yellow
Write-Host "    1. Start server with valid AWS credentials (should succeed)" -ForegroundColor Yellow
Write-Host "    2. Check /api/admin/health/cloudwatch endpoint (should return healthy)" -ForegroundColor Yellow
Write-Host "    3. Verify logs appear in CloudWatch console" -ForegroundColor Yellow
Write-Host "    4. Test with invalid credentials (production should fail to start)" -ForegroundColor Yellow
Write-Host "    5. Verify 6-year retention policy is set" -ForegroundColor Yellow

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "[SUCCESS] ISSUE-008 fix prepared" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Configure AWS credentials in environment" -ForegroundColor White
Write-Host "  2. Update server.js to use CloudWatch validator" -ForegroundColor White
Write-Host "  3. Test in staging environment first" -ForegroundColor White
Write-Host "  4. Verify logs in CloudWatch console" -ForegroundColor White
Write-Host "  5. Commit: git commit -m 'fix: enforce CloudWatch logging validation (ISSUE-008)'" -ForegroundColor White
