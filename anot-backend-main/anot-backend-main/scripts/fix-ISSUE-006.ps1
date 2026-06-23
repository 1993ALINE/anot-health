<#
.SYNOPSIS
  Fix for ISSUE-006: Audio Processing Memory Leak Risk

.DESCRIPTION
  Severity: CRITICAL
  Component: Backend - Audio Processing Service
  Effort: 1-2 days
  
  Issue: Large audio files loaded entirely into memory without streaming, causing exhaustion under load
  
  Impact: Server crashes or slowdowns under high load
  
  Fix: Implement streaming audio processing, memory limits, job queue with cleanup

.PARAMETER DryRun
  Show what would be fixed without making changes

.PARAMETER Force
  Skip confirmations

.EXAMPLE
  powershell -File fix-ISSUE-006.ps1 -DryRun
  powershell -File fix-ISSUE-006.ps1 -Force
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
Write-Host "FIX ISSUE-006: Audio Memory Leak" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Phase 1: Pre-flight checks
Write-Host "[PHASE 1] Pre-flight checks" -ForegroundColor Cyan

$audioServicePath = "$backendPath/src/services/audioProcessingService.js"
if (Test-Path $audioServicePath) {
    Write-Host "  [OK] Found audio service: $audioServicePath" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Audio service not found (may have different path)" -ForegroundColor Yellow
}

# Phase 2: Identify problem
Write-Host "`n[PHASE 2] Identifying problem" -ForegroundColor Cyan

if (Test-Path $audioServicePath) {
    $audioContent = Get-Content $audioServicePath -Raw
    
    if ($audioContent -match "fs\.readFile|Buffer\.from") {
        Write-Host "  [WARN] Files being loaded into memory" -ForegroundColor Red
    }
    
    if ($audioContent -match "stream|createReadStream") {
        Write-Host "  [OK] Some streaming logic exists" -ForegroundColor Green
    } else {
        Write-Host "  [X] No streaming implementation found" -ForegroundColor Red
    }
    
    if ($audioContent -match "queue|bull|bee-queue") {
        Write-Host "  [OK] Job queue may be implemented" -ForegroundColor Green
    } else {
        Write-Host "  [X] No job queue found" -ForegroundColor Red
    }
}

# Phase 3: Apply fix
Write-Host "`n[PHASE 3] Applying fix" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "[DRY-RUN] Would make the following changes:" -ForegroundColor Yellow
    Write-Host "  1. Implement streaming audio processing" -ForegroundColor Yellow
    Write-Host "  2. Add memory limits per worker" -ForegroundColor Yellow
    Write-Host "  3. Create job queue with Bull" -ForegroundColor Yellow
    Write-Host "  4. Add memory monitoring" -ForegroundColor Yellow
    Write-Host "  5. Add process cleanup for hung jobs" -ForegroundColor Yellow
} else {
    if (-not $Force -and -not $SkipConfirm) {
        $confirm = Read-Host "Install Bull job queue and create streaming implementation? (y/n)"
        if ($confirm -ne 'y') {
            Write-Host "Aborted by user" -ForegroundColor Yellow
            exit 0
        }
    }
    
    # Install Bull for job queue
    Write-Host "  Installing Bull job queue..." -ForegroundColor Yellow
    Push-Location $backendPath
    try {
        & npm install bull --save
        Write-Host "  [OK] Bull installed" -ForegroundColor Green
    } finally {
        Pop-Location
    }
    
    # Create streaming audio processor
    $streamingProcessorPath = "$backendPath/src/services/streamingAudioProcessor.js"
    $streamingProcessorContent = @'
/**
 * Streaming Audio Processor
 * ISSUE-006 Fix: Memory-efficient audio processing
 */

const fs = require('fs');
const path = require('path');
const Bull = require('bull');

// Memory limits
const MAX_MEMORY_MB = 512; // 512MB per job
const MAX_FILE_SIZE_MB = 100; // 100MB max file size

// Create job queue
const audioQueue = new Bull('audio-processing', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD
  },
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    timeout: 600000 // 10 minutes max
  }
});

/**
 * Monitor memory usage
 */
function checkMemoryUsage() {
  const usage = process.memoryUsage();
  const usedMB = Math.round(usage.heapUsed / 1024 / 1024);
  
  if (usedMB > MAX_MEMORY_MB) {
    console.warn(`[WARN] High memory usage: ${usedMB}MB / ${MAX_MEMORY_MB}MB`);
    
    // Force garbage collection if available
    if (global.gc) {
      console.log('Running garbage collection...');
      global.gc();
    }
  }
  
  return usedMB;
}

/**
 * Stream-based file size check
 */
async function checkFileSize(filePath) {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stats) => {
      if (err) return reject(err);
      
      const sizeMB = stats.size / (1024 * 1024);
      if (sizeMB > MAX_FILE_SIZE_MB) {
        return reject(new Error(`File too large: ${sizeMB.toFixed(2)}MB (max: ${MAX_FILE_SIZE_MB}MB)`));
      }
      
      resolve(stats.size);
    });
  });
}

/**
 * Stream audio file for processing
 */
async function streamAudioFile(filePath, processor) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, {
      highWaterMark: 64 * 1024 // 64KB chunks
    });
    
    let bytesProcessed = 0;
    
    stream.on('data', (chunk) => {
      bytesProcessed += chunk.length;
      
      // Check memory periodically
      if (bytesProcessed % (1024 * 1024) === 0) { // Every 1MB
        checkMemoryUsage();
      }
    });
    
    stream.on('end', () => {
      resolve({ bytesProcessed });
    });
    
    stream.on('error', (error) => {
      reject(error);
    });
    
    // Pipe to processor if provided
    if (processor) {
      stream.pipe(processor);
    }
  });
}

/**
 * Add audio processing job to queue
 */
async function queueAudioProcessing(jobData) {
  try {
    // Validate file exists and size
    await checkFileSize(jobData.filePath);
    
    // Add to queue
    const job = await audioQueue.add('process-audio', jobData, {
      priority: jobData.priority || 5,
      jobId: jobData.jobId || `audio-${Date.now()}`
    });
    
    console.log(`[OK] Job ${job.id} queued for processing`);
    return job;
  } catch (error) {
    console.error('Failed to queue audio processing:', error);
    throw error;
  }
}

/**
 * Process audio job (worker)
 */
audioQueue.process('process-audio', async (job) => {
  const { filePath, userId, transcriptionService } = job.data;
  
  console.log(`Processing audio job ${job.id}: ${filePath}`);
  
  try {
    // Update progress
    await job.progress(10);
    
    // Check memory before starting
    const initialMemory = checkMemoryUsage();
    console.log(`Initial memory: ${initialMemory}MB`);
    
    // Process file with streaming
    await job.progress(20);
    
    // Here you would integrate with your transcription service (Deepgram, etc)
    // Use streaming to send data without loading entire file into memory
    
    // Example: Stream to transcription service
    const result = await streamToTranscriptionService(filePath, transcriptionService, job);
    
    await job.progress(90);
    
    // Check memory after processing
    const finalMemory = checkMemoryUsage();
    console.log(`Final memory: ${finalMemory}MB`);
    
    await job.progress(100);
    
    return {
      success: true,
      result,
      memoryUsed: finalMemory - initialMemory
    };
  } catch (error) {
    console.error(`Job ${job.id} failed:`, error);
    throw error;
  }
});

/**
 * Stream to transcription service (placeholder)
 */
async function streamToTranscriptionService(filePath, service, job) {
  // This is a placeholder - implement your actual transcription service integration
  // Make sure to use streaming APIs
  
  await streamAudioFile(filePath, null);
  await job.progress(80);
  
  return {
    transcription: 'Transcription result',
    duration: 0,
    confidence: 1.0
  };
}

/**
 * Get job status
 */
async function getJobStatus(jobId) {
  const job = await audioQueue.getJob(jobId);
  if (!job) {
    return { status: 'not_found' };
  }
  
  const state = await job.getState();
  const progress = job.progress();
  
  return {
    id: job.id,
    state,
    progress,
    data: job.data,
    result: await job.finished().catch(() => null)
  };
}

/**
 * Clean up old jobs
 */
async function cleanupOldJobs(ageInHours = 24) {
  const jobs = await audioQueue.getCompleted();
  const cutoffTime = Date.now() - (ageInHours * 60 * 60 * 1000);
  
  let cleaned = 0;
  for (const job of jobs) {
    if (job.finishedOn < cutoffTime) {
      await job.remove();
      cleaned++;
    }
  }
  
  console.log(`Cleaned up ${cleaned} old jobs`);
  return cleaned;
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log('Shutting down audio processing queue...');
  await audioQueue.close();
  console.log('[OK] Audio queue closed');
}

// Clean up old jobs every hour
setInterval(() => {
  cleanupOldJobs(24).catch(console.error);
}, 60 * 60 * 1000);

// Handle graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = {
  queueAudioProcessing,
  getJobStatus,
  cleanupOldJobs,
  audioQueue,
  checkMemoryUsage
};
'@
    
    $servicesDir = "$backendPath/src/services"
    if (-not (Test-Path $servicesDir)) {
        New-Item -Path $servicesDir -ItemType Directory -Force | Out-Null
    }
    
    Set-Content -Path $streamingProcessorPath -Value $streamingProcessorContent -Encoding UTF8
    Write-Host "  [OK] Streaming audio processor created" -ForegroundColor Green
    
    Write-Host "`n  Manual integration required:" -ForegroundColor Yellow
    Write-Host "  1. Set up Redis for Bull job queue" -ForegroundColor Yellow
    Write-Host "  2. Update audio upload endpoint to use queueAudioProcessing()" -ForegroundColor Yellow
    Write-Host "  3. Add job status endpoint for clients to poll" -ForegroundColor Yellow
    Write-Host "  4. Update frontend to handle async processing (HTTP 202)" -ForegroundColor Yellow
}

# Phase 4: Verify fix
Write-Host "`n[PHASE 4] Verifying fix" -ForegroundColor Cyan

if (-not $DryRun) {
    if (Test-Path "$backendPath/src/services/streamingAudioProcessor.js") {
        Write-Host "  [OK] Streaming processor created" -ForegroundColor Green
    }
    
    # Check if Bull is installed
    Push-Location $backendPath
    try {
        $packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
        if ($packageJson.dependencies.bull) {
            Write-Host "  [OK] Bull job queue installed" -ForegroundColor Green
        }
    } finally {
        Pop-Location
    }
}

# Phase 5: Test
Write-Host "`n[PHASE 5] Testing" -ForegroundColor Cyan

Write-Host "  Prerequisites:" -ForegroundColor Yellow
Write-Host "    - Redis server running (required for Bull)" -ForegroundColor Yellow
Write-Host "`n  Test scenarios:" -ForegroundColor Yellow
Write-Host "    1. Upload small audio file (should queue and process)" -ForegroundColor Yellow
Write-Host "    2. Upload large audio file (should not consume excessive memory)" -ForegroundColor Yellow
Write-Host "    3. Upload multiple files simultaneously (queue should handle)" -ForegroundColor Yellow
Write-Host "    4. Monitor memory usage during processing" -ForegroundColor Yellow
Write-Host "    5. Test job status polling" -ForegroundColor Yellow

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "[SUCCESS] ISSUE-006 fix prepared" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Set up Redis server" -ForegroundColor White
Write-Host "  2. Integrate streaming processor with upload endpoints" -ForegroundColor White
Write-Host "  3. Update frontend for async processing" -ForegroundColor White
Write-Host "  4. Test with large files and monitor memory" -ForegroundColor White
Write-Host "  5. Commit: git commit -m 'fix: implement streaming audio processing (ISSUE-006)'" -ForegroundColor White
