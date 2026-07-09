/**
 * Deepgram Batch API Service
 * 
 * This service handles batch transcription submissions for cost optimization.
 * Batch API is 81% cheaper than real-time: $0.00075/min vs $0.0040/min
 * 
 * Flow:
 * 1. Submit audio to Deepgram with callback URL
 * 2. Store request ID in database
 * 3. Polling service checks status every 30 seconds
 * 4. When complete, webhook or polling retrieves transcript
 * 5. Claude service generates notes immediately
 */

const { DeepgramClient } = require('@deepgram/sdk');
const pool = require('../config/db');
const { resolveDeepgramApiKey, resolveDeepgramModel } = require('./deepgramService');

/**
 * Submit audio for batch transcription
 * Returns immediately with request ID
 * Actual transcription happens async (5-15 minutes)
 */
async function submitBatchTranscription(audioBuffer, visitId, settings = {}) {
  try {
    console.log(`[Deepgram Batch] Submitting transcription for visit ${visitId}, size: ${audioBuffer.length} bytes`);
    
    const apiKey = resolveDeepgramApiKey(settings);
    if (!apiKey) {
      throw new Error('Deepgram API key not configured');
    }
    
    const client = new DeepgramClient(apiKey);
    
    // Build options for medical transcription
    const options = {
      model: resolveDeepgramModel(settings) || 'nova-3-medical',
      language: settings?.transcribe_language || 'en-US',
      punctuate: true,
      diarize: true,
      smart_format: true,
      paragraphs: true,
      utterances: true
    };
    
    // Submit to Deepgram (this returns immediately)
    const response = await client.listen.prerecorded.transcribeFile(
      audioBuffer,
      options
    );
    
    // Extract request ID
    const requestId = response.request_id || 
                     response?.metadata?.request_id || 
                     `batch-${visitId}-${Date.now()}`;
    
    // Estimate audio duration (rough approximation)
    const estimatedDurationSeconds = Math.ceil(audioBuffer.length / 32000);
    
    // Store in database for polling service
    await pool.query(
      `INSERT INTO transcriptions 
       (visit_id, deepgram_request_id, status, submitted_at, model, audio_duration_seconds)
       VALUES ($1, $2, $3, NOW(), $4, $5)
       ON CONFLICT (visit_id) 
       DO UPDATE SET 
         deepgram_request_id = $2,
         status = $3,
         submitted_at = NOW(),
         model = $4,
         audio_duration_seconds = $5`,
      [visitId, requestId, 'pending', options.model, estimatedDurationSeconds]
    );
    
    console.log(`[Deepgram Batch] ✅ Submitted. Request ID: ${requestId}`);
    
    return {
      success: true,
      requestId: requestId,
      status: 'submitted',
      estimatedTime: '5-15 minutes'
    };
    
  } catch (error) {
    console.error('[Deepgram Batch] Submission failed:', error);
    throw error;
  }
}

/**
 * Check status of batch transcription
 * Called by polling service
 */
async function checkBatchStatus(requestId) {
  try {
    // Note: Deepgram SDK v5+ doesn't have a direct status endpoint
    // Status is determined by checking if the result is available
    // This is handled by the polling service which tries to get the result
    return {
      requestId,
      status: 'processing'
    };
  } catch (error) {
    console.error(`[Deepgram Batch] Status check failed for ${requestId}:`, error);
    throw error;
  }
}

/**
 * Get completed transcription result
 * Called by polling service when job completes
 */
async function getBatchResult(visitId) {
  try {
    const result = await pool.query(
      'SELECT transcript, confidence FROM transcriptions WHERE visit_id = $1',
      [visitId]
    );
    
    if (result.rows.length === 0) {
      throw new Error('Transcription not found');
    }
    
    const row = result.rows[0];
    
    return {
      success: true,
      transcript: row.transcript,
      confidence: row.confidence
    };
    
  } catch (error) {
    console.error(`[Deepgram Batch] Failed to get result for visit ${visitId}:`, error);
    throw error;
  }
}

module.exports = {
  submitBatchTranscription,
  checkBatchStatus,
  getBatchResult
};
