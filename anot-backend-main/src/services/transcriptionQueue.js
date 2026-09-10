'use strict'

/**
 * transcriptionQueue.js
 * Concurrency-controlled in-process worker queue for audio transcription and AI SOAP note synthesis.
 *
 * Prevents CPU exhaustion from multiple concurrent FFmpeg child processes and avoids
 * hitting Deepgram/Anthropic rate limits during peak clinic consultation waves.
 */

const { runAIPipeline } = require('../utils/aiPipeline')

const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.AI_PIPELINE_CONCURRENCY || '4', 10))

const queue = []
const activeTasks = new Map() // visitId -> { startTime, options }
let totalProcessed = 0
let totalFailed = 0

async function processNext() {
  if (activeTasks.size >= MAX_CONCURRENCY) {
    return
  }

  if (queue.length === 0) {
    return
  }

  const job = queue.shift()
  const { visitId, options, resolve, reject } = job

  // If already running for this visit, skip duplicate execution
  if (activeTasks.has(visitId)) {
    resolve()
    return
  }

  activeTasks.set(visitId, { startTime: Date.now(), options })
  console.log(`[transcription-queue] Starting visit ${visitId} (Active: ${activeTasks.size}/${MAX_CONCURRENCY}, Queued: ${queue.length})`)

  runAIPipeline(visitId, options)
    .then((res) => {
      totalProcessed++
      const duration = Date.now() - activeTasks.get(visitId).startTime
      console.log(`[transcription-queue] ✅ Completed visit ${visitId} in ${duration}ms (Remaining queued: ${queue.length})`)
      resolve(res)
    })
    .catch((err) => {
      totalFailed++
      console.error(`[transcription-queue] ❌ Failed visit ${visitId}:`, err.message)
      reject(err)
    })
    .finally(() => {
      activeTasks.delete(visitId)
      // Process next waiting job
      setImmediate(processNext)
    })
}

/**
 * Enqueue a visit for transcription and AI note synthesis.
 * Returns a Promise that resolves when the pipeline has completed.
 */
function enqueueTranscription(visitId, options = {}) {
  const numId = parseInt(visitId, 10)
  if (!Number.isInteger(numId)) {
    return Promise.reject(new Error(`Invalid visitId: ${visitId}`))
  }

  // If already queued, don't re-queue
  const alreadyQueued = queue.some((j) => j.visitId === numId)
  if (alreadyQueued) {
    console.log(`[transcription-queue] Visit ${numId} is already queued.`)
    return Promise.resolve()
  }

  if (activeTasks.has(numId)) {
    console.log(`[transcription-queue] Visit ${numId} is currently being processed.`)
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    queue.push({ visitId: numId, options, resolve, reject })
    console.log(`[transcription-queue] Enqueued visit ${numId} (Queue depth: ${queue.length}, Active: ${activeTasks.size}/${MAX_CONCURRENCY})`)
    processNext()
  })
}

/**
 * Get current queue diagnostics for health and admin monitoring
 */
function getQueueStatus() {
  return {
    activeCount: activeTasks.size,
    queuedCount: queue.length,
    maxConcurrency: MAX_CONCURRENCY,
    totalProcessed,
    totalFailed,
  }
}

module.exports = {
  enqueueTranscription,
  getQueueStatus,
}
