/**
 * Transcription Polling Service
 * 
 * Polls pending Deepgram batch transcriptions every 30 seconds
 * When a transcription completes:
 * 1. Retrieves the transcript
 * 2. Generates Claude notes immediately  
 * 3. Notifies the scribe via WebSocket
 * 
 * This runs continuously in the background after server startup
 */

const { getTranscript, getTranscriptionStatus } = require('./deepgramService');
const claudeService = require('./claudeService');
const pool = require('../config/db');

let pollingInterval = null;
let isPolling = false;

/**
 * Poll all pending transcriptions
 * Checks database for transcriptions submitted in last 30 minutes
 */
async function pollPendingTranscriptions() {
  if (isPolling) return; // Prevent concurrent polling
  isPolling = true;
  
  try {
    // Find transcriptions submitted in last 30 minutes that are still pending
    const result = await pool.query(
      `SELECT t.id, t.visit_id, t.deepgram_request_id, t.submitted_at, t.model
       FROM transcriptions t
       WHERE t.status = $1
         AND t.submitted_at > NOW() - INTERVAL '30 minutes'
       ORDER BY t.submitted_at ASC`,
      ['pending']
    );
    
    const pendingTranscriptions = result.rows;
    
    if (pendingTranscriptions.length > 0) {
      console.log(`[Polling] Checking ${pendingTranscriptions.length} pending transcriptions`);
    }
    
    for (const transcription of pendingTranscriptions) {
      try {
        // Check status with Deepgram
        const statusResult = getTranscriptionStatus(transcription.deepgram_request_id);
        
        if (statusResult.status === 'completed') {
          // Transcription completed! Get the transcript
          const transcript = getTranscript(transcription.deepgram_request_id);
          
          if (!transcript) {
            console.warn(`[Polling] Empty transcript for visit ${transcription.visit_id}`);
            await markTranscriptionFailed(transcription.id, 'Empty transcript returned');
            continue;
          }
          
          // Save transcript
          await pool.query(
            `UPDATE transcriptions
             SET status = $1,
                 transcript = $2,
                 confidence = $3,
                 completed_at = NOW()
             WHERE id = $4`,
            ['completed', transcript, null, transcription.id]
          );
          
          console.log(`[Polling] ✅ Transcription completed for visit ${transcription.visit_id}`);
          
          // IMMEDIATELY generate Claude notes
          try {
            const notes = await claudeService.generateMedicalNotes(
              transcript,
              transcription.visit_id
            );
            
            if (notes) {
              // Store notes in notes table
              await pool.query(
                `INSERT INTO notes (visit_id, content, ai_draft, transcription, generated_by, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
                 ON CONFLICT (visit_id)
                 DO UPDATE SET
                   ai_draft = $3,
                   transcription = $4,
                   generated_by = $5,
                   updated_at = NOW()`,
                [transcription.visit_id, notes, notes, transcript, 'claude-batch']
              );
              
              // Update visit status
              await pool.query(
                `UPDATE visits
                 SET transcription_status = $1,
                     status = $2
                 WHERE id = $3`,
                ['completed', 'ready_for_review', transcription.visit_id]
              );
              
              console.log(`[Claude] ✅ Notes generated for visit ${transcription.visit_id}`);
              
              // Notify scribe via WebSocket (if available)
              if (global.io) {
                global.io.emit('transcription-complete', {
                  visit_id: transcription.visit_id,
                  status: 'ready_for_review',
                  message: 'Audio transcribed and notes generated!'
                });
              }
            }
            
          } catch (claudeError) {
            console.error(`[Claude] Error generating notes for visit ${transcription.visit_id}:`, claudeError);
            // Log error but don't fail transcription - store raw transcript
            await pool.query(
              `INSERT INTO notes (visit_id, transcription, content, generated_by, created_at, updated_at)
               VALUES ($1, $2, $3, $4, NOW(), NOW())
               ON CONFLICT (visit_id)
               DO UPDATE SET
                 transcription = $2,
                 content = $3,
                 generated_by = $4,
                 updated_at = NOW()`,
              [transcription.visit_id, transcript, 'Transcript: ' + transcript.substring(0, 500) + '...', 'manual']
            );
            
            await pool.query(
              `UPDATE visits SET transcription_status = $1 WHERE id = $2`,
              ['completed', transcription.visit_id]
            );
          }
          
        } else if (statusResult.status === 'failed') {
          console.error(`[Polling] ❌ Transcription failed for visit ${transcription.visit_id}`);
          await markTranscriptionFailed(transcription.id, statusResult.error || 'Transcription failed');
          
          if (global.io) {
            global.io.emit('transcription-error', {
              visit_id: transcription.visit_id,
              error: 'Transcription failed. Please retry.'
            });
          }
          
        } else {
          // Still processing - check if too old
          const submittedTime = new Date(transcription.submitted_at);
          const ageMinutes = (Date.now() - submittedTime.getTime()) / 60000;
          
          if (ageMinutes > 25) {
            // Over 25 minutes old - likely stuck or failed
            console.error(`[Polling] ⏱️ Transcription timeout for visit ${transcription.visit_id} (${ageMinutes.toFixed(1)} min)`);
            await markTranscriptionFailed(transcription.id, `Timeout after ${ageMinutes.toFixed(0)} minutes`);
            
            if (global.io) {
              global.io.emit('transcription-error', {
                visit_id: transcription.visit_id,
                error: 'Transcription timeout. Please retry.'
              });
            }
          }
        }
        
      } catch (error) {
        console.error(`[Polling] Error processing transcription ${transcription.id}:`, error);
      }
    }
    
  } catch (error) {
    console.error('[Polling] Fatal error in polling:', error);
  } finally {
    isPolling = false;
  }
}

/**
 * Mark a transcription as failed
 */
async function markTranscriptionFailed(transcriptionId, errorMessage) {
  try {
    await pool.query(
      `UPDATE transcriptions
       SET status = $1,
           error = $2,
           completed_at = NOW()
       WHERE id = $3`,
      ['failed', errorMessage, transcriptionId]
    );
  } catch (error) {
    console.error('[Polling] Failed to mark transcription as failed:', error);
  }
}

/**
 * Start the polling service
 * Polls every 30 seconds
 */
function startPolling() {
  if (pollingInterval) {
    console.log('[Polling] Already running');
    return;
  }
  
  console.log('[Polling] 🚀 Starting transcription polling service');
  
  // Poll every 30 seconds
  pollingInterval = setInterval(pollPendingTranscriptions, 30000);
  
  // Run immediately on startup
  pollPendingTranscriptions();
}

/**
 * Stop the polling service
 */
function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('[Polling] ⛔ Stopped transcription polling service');
  }
}

module.exports = {
  startPolling,
  stopPolling,
  pollPendingTranscriptions
};
