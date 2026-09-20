const Anthropic = require('@anthropic-ai/sdk');
const { resolveCanonicalAnthropicModel } = require('./aiSettings');
const { cleanTranscriptForClinicalPrompt } = require('../utils/aiPipelineHelpers');
const {
  checkRateLimit,
  checkCostLimit,
  trackCost,
  getCostStats,
  resetDailyCost,
  MODEL_PRICING,
} = require('./claudeCostTracking');

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY
});

// Structured medical system prompt — concise but covers full SOAP format
const MEDICAL_SYSTEM_PROMPT = `You are a clinical documentation specialist. Generate a complete, structured SOAP note from the provided medical visit transcript.

Format strictly as:
CHIEF COMPLAINT: [1 sentence]
HISTORY OF PRESENT ILLNESS: [2-4 sentences covering onset, duration, severity, associated symptoms]
CURRENT MEDICATIONS: [Bullet list of all active/current medications with doses, routes, and frequencies, or "None documented this encounter."]
PHYSICAL EXAMINATION: [Key findings only, or "Not documented" if not in transcript]
ASSESSMENT: [Primary diagnosis/impression, numbered if multiple]
PLAN: [Numbered action items — all medication orders/refills with doses and frequencies, follow-up, referrals, patient instructions]
ICD-10 CODES: [1-3 most relevant codes with descriptions]

Rules: Use only information from the transcript. Document all mentioned medications with exact dosages, routes, and frequencies. Be concise and medically precise. Do not invent findings.`;

// Pricing/model constant kept for backward compatibility with anything reading
// CLAUDE_COSTS directly — cost tracking itself now lives in claudeCostTracking.js
// (checkRateLimit/checkCostLimit/trackCost/getCostStats/resetDailyCost, imported
// above), used by both this dead function and the real path in aiPipeline.js.
const CLAUDE_COSTS = {
  ...MODEL_PRICING['claude-haiku-4-5-20251001'],
  model: 'claude-haiku-4-5-20251001',
};

/**
 * Delegates to the real, tested transcript-cleanup implementation in
 * aiPipelineHelpers.js (cleanTranscriptForClinicalPrompt) — kept as a thin wrapper
 * here so nothing below has to change, rather than maintaining a second copy of
 * the same filler/pleasantry/dedupe logic. See that function for the actual rules.
 */
function extractKeyMedicalInfo(transcript) {
  if (!transcript || transcript.length < 50) {
    return transcript;
  }
  const cleaned = cleanTranscriptForClinicalPrompt(transcript);
  // Hard cap at 80,000 chars (~20,000 tokens) — well within Haiku's 200k context
  // A 30-min visit is ~8,000 chars. This cap only activates for 5+ hour recordings.
  return cleaned.substring(0, 80000);
}

/**
 * ⚠ NOT CALLED IN PRODUCTION. The live note-generation path is generateAINote()
 * in src/utils/aiPipeline.js, called from src/routes/visits.js — it always uses
 * whatever model is selected in Admin Settings, with no auto-escalation (see the
 * comment on callAnthropicForNote in aiPipeline.js for why that was removed).
 * This function's cost tracking (trackCost/checkCostLimit/checkRateLimit below) is
 * therefore also not exercised in production — the claude_usage_log table has no
 * rows from real traffic. Kept for now since nothing currently imports it besides
 * extractKeyMedicalInfo's tests; do not add new callers without first wiring the
 * cost tracking into the real path in aiPipeline.js instead.
 *
 * Generate medical notes from transcript using Claude Haiku.
 */
async function generateMedicalNotes(transcript, visitId) {
  try {
    console.log(`[Claude] Generating notes for visit ${visitId}`);
    
    if (!transcript || transcript.trim().length === 0) {
      console.warn(`[Claude] Empty transcript for visit ${visitId}`);
      return null;
    }
    
    // Safety check 1: Rate limiting
    try {
      checkRateLimit();
    } catch (rateLimitError) {
      console.error(`[Claude] Rate limit for visit ${visitId}:`, rateLimitError.message);
      throw rateLimitError;
    }
    
    // Safety check 2: Cost limit (if enabled)
    try {
      checkCostLimit();
    } catch (costLimitError) {
      console.error(`[Claude] Cost limit for visit ${visitId}:`, costLimitError.message);
      throw costLimitError;
    }
    
    const keyInfo = extractKeyMedicalInfo(transcript);

    const startTime = Date.now();

    // No auto-escalation to a pricier model on transcript length — that used to
    // silently switch long-but-simple visits to Sonnet regardless of what was
    // configured. Removed to match the policy already enforced in the live path
    // (see callAnthropicForNote in aiPipeline.js): model choice is never an
    // implicit override, only an explicit Admin Settings selection.
    const activeModel = resolveCanonicalAnthropicModel(CLAUDE_COSTS.model);
    const response = await anthropic.messages.create({
      model: activeModel,
      max_tokens: 1200, // Enough for a complete structured SOAP note with ICD-10 codes
      system: [{
        type: 'text',
        text: MEDICAL_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' } // Cache system prompt across calls
      }],
      messages: [{
        role: 'user',
        content: `Generate a complete SOAP note from this clinical visit transcript:\n\n${keyInfo}`
      }]
    });
    
    const duration = Date.now() - startTime;
    const notes = response.content[0].type === 'text' ? response.content[0].text : '';
    
    // Extract token usage (including cache metrics)
    const inputTokens = response.usage.input_tokens || 0;
    const outputTokens = response.usage.output_tokens || 0;
    const cacheCreationTokens = response.usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = response.usage.cache_read_input_tokens || 0;
    
    // Track cost with enhanced metrics
    await trackCost(visitId, activeModel, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);
    
    // Enhanced logging
    const cacheInfo = cacheReadTokens > 0 ? ` | Cache hit: ${cacheReadTokens} tokens` : '';
    console.log(
      `[Claude] ✅ Visit ${visitId} complete | ` +
      `${inputTokens} in, ${outputTokens} out${cacheInfo} | ` +
      `${duration}ms | ` +
      `${notes.length} chars`
    );
    
    return notes;
    
  } catch (error) {
    console.error(`[Claude] Error generating notes for visit ${visitId}:`, error.message);
    
    // Don't re-throw rate limit or cost limit errors - they're informational
    if (error.message.includes('Rate limit') || error.message.includes('cost limit')) {
      throw error;
    }
    
    // For API errors, log but return null so the workflow can continue
    if (error.status === 429) {
      console.error(`[Claude] API rate limited (429) - try again later`);
    } else if (error.status === 529) {
      console.error(`[Claude] API overloaded (529) - try again later`);
    }
    
    throw error;
  }
}

// Batch generation (50% cheaper with Batch API - optional future optimization)
async function generateBatch(_transcripts) {
  // For later: use Claude Batch API for further cost reduction
  // Not needed for Saturday launch
  console.warn('[Claude] Batch generation not yet implemented');
}

module.exports = {
  generateMedicalNotes,
  generateBatch,
  getCostStats,
  resetDailyCost,
  CLAUDE_COSTS,
  /** exposed for tests only */
  extractKeyMedicalInfo,
};
