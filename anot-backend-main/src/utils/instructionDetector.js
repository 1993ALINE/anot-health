/**
 * Clinical Scribe Instruction & Embedded Command Detector
 * 
 * Identifies direct physician commands to the documentation system
 * (e.g. copy-forward requests, manual exam insertion instructions, and
 * unresolvable ASR corruption tokens) that must never be answered with
 * hallucinated content. Generates QA-compliant placeholders — clinical-record-safe text
 * only; any "do not sign" style reminder belongs in the review workflow UI, not the note body.
 */

/**
 * Detects copy-forward, insertion, and workflow instructions from transcript text.
 * @param {string} transcript
 * @returns {{
 *   hasInstructions: boolean,
 *   copyForwardRequested: boolean,
 *   insertRequested: boolean,
 *   hasPendingActions: boolean,
 *   formattedExamPlaceholder: string | null,
 *   unclearTokens: Array<{ token: string, query: string }>
 * }}
 */
function detectScribeInstructions(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return {
      hasInstructions: false,
      copyForwardRequested: false,
      insertRequested: false,
      hasPendingActions: false,
      formattedExamPlaceholder: null,
      unclearTokens: [],
    }
  }

  const raw = transcript.replace(/\r\n/g, '\n')
  const lower = raw.toLowerCase()

  const examItems = []
  let copyForwardRequested = false
  let insertRequested = false

  // 1. Check for copy-forward commands:
  // e.g. "Please copy over prior right knee exam", "copy forward prior knee exam", "pull forward last exam"
  const copyMatches = [
    ...lower.matchAll(/(?:please\s+)?(?:copy\s+(?:over|forward)|pull\s+forward|carry\s+forward|use\s+(?:prior|last)\s+note'?s|same\s+as\s+before)\s+(?:the\s+)?(?:prior|previous|last)?\s*([a-z0-9\s\-]+?)\s*(?:exam|examination|physical\s+exam)/gi),
  ]

  for (const m of copyMatches) {
    copyForwardRequested = true
    const target = (m[1] || '').trim() || 'prior'
    // Capitalize target words nicely (e.g. "right knee" -> "Right Knee")
    const label = target
      .replace(/\b(?:prior|the|last|previous)\b/gi, '')
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ') || 'Prior Area'

    examItems.push({
      target: label,
      type: 'copy_forward',
      text: `  ${label}: Not documented this encounter.`,
    })
  }

  // 2. Check for manual exam insertion commands:
  // e.g. "Please insert a left knee, physical exam", "insert right shoulder exam", "add exam for left knee"
  const insertMatches = [
    ...lower.matchAll(/(?:please\s+)?(?:insert|add)\s+(?:a\s+)?([a-z0-9\s\-]+?)(?:,\s*)?(?:physical\s+exam|exam|examination)/gi),
  ]

  for (const m of insertMatches) {
    const target = (m[1] || '').trim()
    if (!target) continue
    // Filter out common non-anatomic filler phrases
    if (/^(?:a|an|the|new|another)$/i.test(target)) continue

    insertRequested = true
    const label = target
      .replace(/\b(?:a|an|the)\b/gi, '')
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ')

    // Prevent duplicate target label
    if (!examItems.some((item) => item.target.toLowerCase() === label.toLowerCase())) {
      examItems.push({
        target: label,
        type: 'insert',
        text: `  ${label}: Not documented this encounter.`,
      })
    }
  }

  // 3. Fallback check if "copy over prior" was spoken without matching the full regex above
  if (!copyForwardRequested && /(?:copy\s+over\s+prior|copy\s+forward|pull\s+forward)/i.test(lower)) {
    copyForwardRequested = true
    examItems.push({
      target: 'Exam',
      type: 'copy_forward',
      text: '  Not documented this encounter.',
    })
  }

  // 4. Fallback check if "insert ... exam" was spoken without matching the full regex
  if (!insertRequested && /(?:insert|add)\s+(?:a\s+)?(?:physical\s+)?exam/i.test(lower)) {
    insertRequested = true
    examItems.push({
      target: 'Exam',
      type: 'insert',
      text: '  Not documented this encounter.',
    })
  }

  // 5. Check for known unresolvable/garbled ASR tokens that require physician query
  const unclearTokens = []
  if (/\brecrelated\b/i.test(lower)) {
    unclearTokens.push({
      token: 'recrelated',
      query: '[UNCLEAR: recreational vs. work-related — query physician]',
    })
  }

  const hasPendingActions = copyForwardRequested || insertRequested

  // De-duplicate identical placeholder lines (e.g. the same body part matched by both the
  // primary and fallback regexes) so the final note never repeats the same exam line twice.
  const seenLines = new Set()
  const dedupedItems = examItems.filter((it) => {
    if (seenLines.has(it.text)) return false
    seenLines.add(it.text)
    return true
  })

  // NOTE: this placeholder text is written verbatim into the clinical note body, so it must
  // read as clinical documentation ("Not documented this encounter"), never as an internal
  // workflow instruction (e.g. a "DO NOT SIGN" banner) — that kind of reminder belongs in the
  // review UI/workflow layer, not the permanent record.
  let formattedExamPlaceholder = null
  if (dedupedItems.length > 0) {
    formattedExamPlaceholder = dedupedItems.map((it) => it.text).join('\n')
  }

  return {
    hasInstructions: copyForwardRequested || insertRequested || unclearTokens.length > 0,
    copyForwardRequested,
    insertRequested,
    hasPendingActions,
    formattedExamPlaceholder,
    unclearTokens,
  }
}

/**
 * Normalizes unresolvable tokens into physician queries in interval history or HPI
 * @param {string} text
 * @returns {string}
 */
function normalizeUnresolvableTokens(text) {
  if (!text || typeof text !== 'string') return ''
  return text.replace(/\brecrelated\s+(?:injury)?/gi, '[UNCLEAR: recreational vs. work-related — query physician] injury')
}

module.exports = {
  detectScribeInstructions,
  normalizeUnresolvableTokens,
}
