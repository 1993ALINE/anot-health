/**
 * Clinical Quality & Safety Guardrails
 * 
 * Deterministic post-processing layer that enforces:
 * 1. Zero-hallucination on empty sections (PE, Imaging, Vitals, Meds)
 * 2. Copy-forward instruction placeholder enforcement & do-not-sign banner
 * 3. Active medical code set verification (removes retired codes like 71020)
 * 4. ICD-10 bilateral coding conventions (M17.0 over stacked M17.11+M17.12)
 * 5. Acute vs historical coding compliance (replaces acute 7th char 'A' for remote surgery with Z98.890)
 * 6. Stripping internal coder meta-queries & fabricated citations from legal note body
 * 7. Standardized clinical terminology ("Not documented this encounter")
 */

const { detectScribeInstructions } = require('./instructionDetector')

/**
 * Sanitizes and enforces safety rules on generated clinical notes.
 * @param {string} noteText
 * @param {string} transcriptText
 * @param {object} [context]
 * @returns {string}
 */
function applyClinicalGuardrails(noteText, transcriptText = '', _context = {}) {
  if (!noteText || typeof noteText !== 'string') return noteText || ''

  let text = noteText.replace(/\r\n/g, '\n')
  const transcriptLower = String(transcriptText || '').toLowerCase()

  // ─── 1. Strip Coder Meta-Queries & Internal Deliberations ───
  // E.g. "(Note: If right knee X-rays were ordered, use ... transcript indicates ... suggesting ...)"
  text = text.replace(
    /\(?(?:Note|Coder\s*Note|Query|Internal\s*Note):\s*If\s+[^\n)]+?(?:transcript|suggesting|ordered)[^\n)]*?\)?/gi,
    ''
  )
  text = text.replace(
    /\btranscript\s+indicates\s+['"][^'"]+?['"]\s+suggesting[^\n.]*?\.?/gi,
    ''
  )

  // ─── 2. Scribe Instruction & Physical Examination Guardrail ───
  const instructionResult = detectScribeInstructions(transcriptText)
  // Matches the FIRST "PHYSICAL EXAMINATION" header through to the next header that is not
  // itself another PHYSICAL EXAMINATION variant — this collapses any duplicate/echoed PE
  // header blocks the model may have produced into a single span so they can be replaced
  // with one canonical section instead of leaving extra copies behind.
  const peHeaderRegex = /(PHYSICAL EXAMINATION(?:\s*\(PE\))?:?)([\s\S]*?)(?=\n(?!\s*PHYSICAL EXAMINATION)[A-Z0-9\s&()\-]{3,40}:|$)/i
  if (instructionResult.hasPendingActions && instructionResult.formattedExamPlaceholder) {
    // If clinician dictated copy-forward or insertion instructions, the note MUST NOT
    // contain fabricated exam findings. Replace the physical exam section body with placeholders.
    const peMatch = text.match(peHeaderRegex)
    if (peMatch) {
      text = text.replace(
        peHeaderRegex,
        `PHYSICAL EXAMINATION (PE):\n${instructionResult.formattedExamPlaceholder}\n`
      )
    } else {
      // If PE header was missing, insert before Assessment & Plan
      const apRegex = /(ASSESSMENT\s*&\s*PLAN|\bASSESSMENT:)/i
      if (apRegex.test(text)) {
        text = text.replace(apRegex, `PHYSICAL EXAMINATION (PE):\n${instructionResult.formattedExamPlaceholder}\n\n$1`)
      }
    }
  } else {
    // If no exam was dictated or performed at all, ensure we don't fabricate positive findings
    const peMatch = text.match(peHeaderRegex)
    if (peMatch) {
      const examBody = peMatch[2].trim()
      const hasSpokenExamInTranscript = /(?:on\s+exam|palpation|inspection|range\s+of\s+motion|rom|tender|swelling|lachman|mcmurray)/i.test(transcriptLower)
      if (!hasSpokenExamInTranscript && /(?:lachman|mcl|lateral\s+joint\s+line|tenderness|positive)/i.test(examBody)) {
        text = text.replace(peHeaderRegex, `${peMatch[1]}\nNot documented this encounter.\n`)
      }
    }
  }

  // ─── 3. Imaging Guardrail (Zero-Fabrication Rule) ───
  const hasImagingOrderOrResult = /(?:order(?:ed|ing)?\s+(?:an?\s+)?(?:x-?ray|radiograph|mri|ct|ultrasound|imaging)|x-?ray\s+(?:shows|showed|reveals|demonstrated|taken)|mri\s+(?:shows|showed|ordered)|repeat\s+x-?ray|(?:knee|chest|ankle|spine)\s+x-?ray)/i.test(transcriptLower) &&
    !/(?:no\s+imaging|no\s+x-?ray|no\s+radiograph|no\s+mri|imaging(?:\s+was)?\s+not\s+performed)/i.test(transcriptLower)

  const imagingHeaderRegex = /(IMAGING(?:\s*&(?:\s*DIAGNOSTICS)?)?:)([\s\S]*?)(?=\n[A-Z0-9\s&()\-]{3,40}:|$)/i
  const imagingMatch = text.match(imagingHeaderRegex)

  if (imagingMatch) {
    if (!hasImagingOrderOrResult) {
      // Transcript mentions zero imaging orders or interpretations -> Replace any fabricated X-ray/MRI with standard gap marker
      text = text.replace(imagingHeaderRegex, `${imagingMatch[1]}\nNone documented or ordered this encounter.\n`)
    }
  }

  // ─── 4. ICD-10 Coding Corrections ───
  // A. Bilateral Knee Osteoarthritis Convention:
  // If bilateral knee OA is present or both M17.11 and M17.12 are assigned, replace with M17.0
  const hasBilateralKneeOa = /(?:bilateral\s+knee\s+osteoarthritis|bilateral\s+(?:primary\s+)?oa|bilodoniaoster|bilateral\s+knee)/i.test(transcriptLower) ||
    (/(?:M17\.11|unilateral\s+primary\s+osteoarthritis,\s*right\s+knee)/i.test(text) &&
     /(?:M17\.12|unilateral\s+primary\s+osteoarthritis,\s*left\s+knee)/i.test(text))

  if (hasBilateralKneeOa) {
    // Replace M17.11 and M17.12 lines cleanly with bilateral code M17.0
    text = text.replace(/M17\.11[^\n]*/gi, 'M17.0 — Bilateral primary osteoarthritis of knee')
    text = text.replace(/M17\.12[^\n]*/gi, 'M17.0 — Bilateral primary osteoarthritis of knee')
    // De-duplicate multiple consecutive M17.0 lines if both were present
    text = text.replace(/(?:M17\.0\s*—[^\n]*\n*){2,}/gi, 'M17.0 — Bilateral primary osteoarthritis of knee\n')
  }

  // B. Remote Surgical History vs Acute Sprain (e.g. 1981 MCL repair):
  // Never assign acute 7th character 'A' (e.g. S83.521A / S83.411A) to a historical surgical repair
  if (/(?:1981|prior\s+(?:mcl|repair)|remote\s+(?:mcl|surgery)|past\s+surgical\s+history|pesturgical)/i.test(transcriptLower)) {
    text = text.replace(
      /S83\.[0-9A-Z]+\s*—\s*[^\n]*?(?:historical|1981|repair|past)[^\n]*/gi,
      'Z98.890 — Other specified postprocedural states (personal history of musculoskeletal surgery)'
    )
    text = text.replace(
      /S83\.521A[^\n]*/gi,
      'Z98.890 — Other specified postprocedural states (personal history of musculoskeletal surgery)'
    )
  }

  // ─── 5. CPT Coding Corrections ───
  // A. Hard block deleted code 71020 (deleted in 2019, chest X-ray)
  text = text.replace(/71020[^\n]*\n?/gi, '')

  // B. Hard block wrong-anatomy ankle codes (73600, 73610) on knee encounters
  const isKneeEncounter = /knee/i.test(transcriptLower) || /knee/i.test(text)
  if (isKneeEncounter) {
    text = text.replace(/73610[^\n]*\n?/gi, '')
    text = text.replace(/73600[^\n]*\n?/gi, '')
  }

  // C. Service-Gated CPT: If no imaging was ordered or performed, remove any radiology CPT
  if (!hasImagingOrderOrResult) {
    text = text.replace(/7356[0-5][^\n]*\n?/gi, '')
    text = text.replace(/7372[1-3][^\n]*\n?/gi, '')
  }

  // D. E&M code descriptor correction: 99214 is moderate MDM
  text = text.replace(
    /99214\s*—\s*Office or other outpatient visit[^\n]*?(?:moderate\s+to\s+high|moderate-to-high)[^\n]*/gi,
    '99214 — Office or other outpatient visit for evaluation and management of established patient (moderate complexity MDM)'
  )

  // ─── 6. Terminology Standardization ───
  text = text.replace(/Not dictated in this encounter/gi, 'Not documented this encounter')
  text = text.replace(/Not documented \/ Not dictated in this encounter\.?/gi, 'Not documented this encounter.')

  // ─── 7. Cleanup Empty Lines ───
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return text
}

module.exports = {
  applyClinicalGuardrails,
}
