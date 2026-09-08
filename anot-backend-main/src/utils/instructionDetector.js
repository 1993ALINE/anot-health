/**
 * Clinical Scribe Instruction & Embedded Command Detector
 * 
 * Identifies direct physician commands to the documentation system
 * (e.g. copy-forward requests, manual exam insertion instructions, and
 * unresolvable ASR corruption tokens) that must never be answered with
 * hallucinated content. Generates QA-compliant placeholders and signature blocks.
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
 *   unclearTokens: Array<{ token: string, query: string }>,
 *   doNotSignBanner: string | null
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
      doNotSignBanner: null,
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
      text: `  ${label}: [COPY FORWARD from prior encounter — per dictation, action pending]`,
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
        text: `  ${label}: [PENDING — examination to be entered]`,
      })
    }
  }

  // 3. Fallback check if "copy over prior" was spoken without matching the full regex above
  if (!copyForwardRequested && /(?:copy\s+over\s+prior|copy\s+forward|pull\s+forward)/i.test(lower)) {
    copyForwardRequested = true
    examItems.push({
      target: 'Exam',
      type: 'copy_forward',
      text: '  [COPY FORWARD from prior encounter — per dictation, action pending]',
    })
  }

  // 4. Fallback check if "insert ... exam" was spoken without matching the full regex
  if (!insertRequested && /(?:insert|add)\s+(?:a\s+)?(?:physical\s+)?exam/i.test(lower)) {
    insertRequested = true
    examItems.push({
      target: 'Exam',
      type: 'insert',
      text: '  [PENDING — examination to be entered]',
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
  const doNotSignBanner = hasPendingActions ? '*** DO NOT SIGN — exam content outstanding ***' : null

  let formattedExamPlaceholder = null
  if (examItems.length > 0) {
    formattedExamPlaceholder = [
      ...examItems.map((it) => it.text),
      `  ${doNotSignBanner}`,
    ].join('\n')
  }

  return {
    hasInstructions: copyForwardRequested || insertRequested || unclearTokens.length > 0,
    copyForwardRequested,
    insertRequested,
    hasPendingActions,
    formattedExamPlaceholder,
    unclearTokens,
    doNotSignBanner,
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
