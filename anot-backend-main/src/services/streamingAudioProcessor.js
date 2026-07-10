/**
 * Streaming Audio Processor
 * ISSUE-006 Fix: Memory-efficient audio processing
 */

const fs = require('fs');
const path = require('path');
const Bull = require('bull');
const { resolveFfmpegMaxUploadMb } = require('../utils/ffmpegUploadLimits');

// Memory limits
const MAX_MEMORY_MB = 512; // 512MB per job

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
      const maxMb = resolveFfmpegMaxUploadMb();
      if (sizeMB > maxMb) {
        return reject(new Error(`File too large: ${sizeMB.toFixed(2)}MB (max: ${maxMb}MB)`));
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
