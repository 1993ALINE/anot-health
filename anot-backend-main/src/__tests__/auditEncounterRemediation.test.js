/**
 * Comprehensive Audit Encounter Reproduction & Remediation Test
 * 
 * Tests the Anot Documentation Engine against the exact orthopedic encounter from the
 * Senior QA Specialist Atiqur Rahman audit (Anot vs. Knowtex, 8 Sept 2026).
 */

const { detectScribeInstructions, normalizeUnresolvableTokens } = require('../utils/instructionDetector')
const { applyClinicalGuardrails } = require('../utils/clinicalGuardrails')
const { buildAnthropicNotePrompt, extractDictatedPatientDetails } = require('../utils/aiPipelineHelpers')
const { formatClinicalDictationToSOAP } = require('../utils/clinicalSoapSynthesizer')

const AUDIT_TRANSCRIPT = `
The patient is a 63-year-old male welder presenting for bilateral knee osteoarthritis, horse on the right than the left.
He sustained a recrelated injury a little over a year ago after stepping on the board of a truck.
Severe medium, patellar femoral pain with bone-on-bone changes, worse with stepping down. Fall triggered information.
Pesturgical history: right MCL repair in 1981. Previous quarter zone injection to right knee only under his case.
Please copy over prior right knee exam. Please insert a left knee, physical exam.
Assessment: 6-year-old male with severe bilateral knee osteoarthritis.
I'm going to go ahead and request for a bilateral hyaluronic acid injections.
I do believe this is reasonable to address the patient's osteoarthritic changes and provide cushioning so that he can better participate in PT to see if it can improve overall in function.
Follow up in 6 weeks or sooner if injection therapy is approved.
`.trim()

describe('Audit Encounter Remediation (Anot vs Knowtex)', () => {
  test('A-06: extracts age 63 and refuses single-digit ASR truncation (6) or reconciliation (60)', () => {
    const details = extractDictatedPatientDetails(AUDIT_TRANSCRIPT)
    expect(details).not.toBeNull()
    expect(details.age).toBe(63)
    expect(details.age).not.toBe(6)
    expect(details.age).not.toBe(60)
    expect(details.gender).toBe('male')
  })

  test('S-01: detects unresolvable token recrelated and emits physician query', () => {
    const instructions = detectScribeInstructions(AUDIT_TRANSCRIPT)
    expect(instructions.unclearTokens.length).toBeGreaterThan(0)
    expect(instructions.unclearTokens[0].query).toContain('recreational vs. work-related — query physician')

    const normalized = normalizeUnresolvableTokens(AUDIT_TRANSCRIPT)
    expect(normalized).toContain('[UNCLEAR: recreational vs. work-related — query physician]')
  })

  test('A-01 & A-12 & K-01 & K-02: instruction detection layer creates labeled, clinical-record-safe placeholders', () => {
    const instructions = detectScribeInstructions(AUDIT_TRANSCRIPT)
    expect(instructions.copyForwardRequested).toBe(true)
    expect(instructions.insertRequested).toBe(true)
    expect(instructions.hasPendingActions).toBe(true)
    // Placeholder text is written verbatim into the note body, so it must read as clinical
    // documentation, never as an internal workflow reminder (no "DO NOT SIGN", no brackets).
    expect(instructions.formattedExamPlaceholder).toContain('Right Knee: Not documented this encounter.')
    expect(instructions.formattedExamPlaceholder).toContain('Left Knee: Not documented this encounter.')
    expect(instructions.formattedExamPlaceholder).not.toContain('DO NOT SIGN')
    expect(instructions.formattedExamPlaceholder).not.toContain('PENDING')
  })

  test('Prompt includes embedded scribe command directives and coding rules', () => {
    const patientInfo = { patient_name: 'John Doe', mrn: '12345', visit_type: 'Follow-up', visit_date: '2026-09-08' }
    const prompt = buildAnthropicNotePrompt(patientInfo, AUDIT_TRANSCRIPT)
    expect(prompt).toContain('EMBEDDED SCRIBE COMMANDS DETECTED IN TRANSCRIPT:')
    expect(prompt).toContain('write EXACTLY the following lines, once')
    expect(prompt).toContain('CRITICAL SAFETY RULE: Under NO circumstances should you fabricate')
    expect(prompt).toContain('M17.0 (Bilateral primary osteoarthritis of knee)')
    expect(prompt).toContain('Z98.890')
    expect(prompt).toContain('71020')
  })

  test('Full Guardrail Remediation: intercepts all 4 fabrications, coding errors, and coder deliberations', () => {
    // Simulate what the unhardened model previously hallucinated:
    const flawedNoteFromAudit = `
CHIEF COMPLAINT:
Bilateral knee pain

HISTORY OF PRESENT ILLNESS (HPI):
The patient is a 60-year-old male with recreational injury. Pain is described with bone changes.

VITAL SIGNS:
Not documented / Not dictated in this encounter.

PHYSICAL EXAMINATION (PE):
Positive tenderness to palpation over the MCL joint. Positive tenderness to palpation over the lateral joint line. Positive Lachman test.

IMAGING:
Right knee X-ray shows mild degenerative changes.
(Note: If right knee X-rays were ordered, use 73560, transcript indicates 'right knee access' suggesting knee imaging)

ASSESSMENT & PLAN (A&P):
ASSESSMENT:
1. Bilateral knee osteoarthritis.

PLAN:
1. Injection therapy discussed. Hyaluronic acid injections were discussed with the patient as an alternative therapeutic option and completed.
2. Follow-up in 6 weeks and completed.

ICD-10 CODES:
M17.11 — Unilateral primary osteoarthritis, right knee
M17.12 — Unilateral primary osteoarthritis, left knee
S83.521A — Sprain of collateral ligament of right knee, initial encounter (historical 1981 repair)

CPT CODES:
99214 — Office or other outpatient visit (moderate-to-high complexity)
71020 — Chest X-ray, two views
73610 — Radiologic examination, ankle; 3 views
73600 — Radiologic examination, ankle; 2 views
`.trim()

    const sanitized = applyClinicalGuardrails(flawedNoteFromAudit, AUDIT_TRANSCRIPT)

    // A-01: Zero fabricated Lachman or tenderness; clinical-record-safe placeholders present
    expect(sanitized).not.toContain('Positive Lachman test')
    expect(sanitized).not.toContain('tenderness to palpation over the MCL joint')
    expect(sanitized).toContain('Right Knee: Not documented this encounter.')
    expect(sanitized).toContain('Left Knee: Not documented this encounter.')
    expect(sanitized).not.toContain('DO NOT SIGN')
    expect(sanitized).not.toContain('PENDING')
    // The guardrail must collapse to a single PHYSICAL EXAMINATION section, not repeat it
    expect((sanitized.match(/PHYSICAL EXAMINATION/gi) || []).length).toBe(1)

    // A-02: Zero fabricated X-ray results
    expect(sanitized).not.toContain('Right knee X-ray shows mild degenerative changes')
    expect(sanitized).toContain('None documented or ordered this encounter.')

    // A-03 & A-09: Coder query and fabricated citation stripped
    expect(sanitized).not.toContain('transcript indicates')
    expect(sanitized).not.toContain('right knee access')
    expect(sanitized).not.toContain('Note: If right knee X-rays were ordered')

    // A-10: M17.0 Bilateral primary OA assigned; stacked M17.11/M17.12 eliminated
    expect(sanitized).toContain('M17.0 — Bilateral primary osteoarthritis of knee')
    expect(sanitized).not.toContain('M17.11')
    expect(sanitized).not.toContain('M17.12')

    // A-11: Remote 1981 surgical repair mapped to Z98.890; acute S83.521A eliminated
    expect(sanitized).not.toContain('S83.521A')
    expect(sanitized).toContain('Z98.890')

    // A-05 & A-07: Deleted 71020 and wrong-anatomy ankle codes 73610/73600 eliminated
    expect(sanitized).not.toContain('71020')
    expect(sanitized).not.toContain('73610')
    expect(sanitized).not.toContain('73600')

    // A-18: E&M descriptor 99214 corrected to moderate complexity MDM
    expect(sanitized).toContain('moderate complexity MDM')

    // Terminology: Not documented this encounter
    expect(sanitized).not.toContain('Not dictated in this encounter')
  })

  test('Offline Synthesizer Engine produces accurate bilateral OA note with HA order and copy-forward placeholder', () => {
    const offlineNote = formatClinicalDictationToSOAP(AUDIT_TRANSCRIPT, '', 'Follow-up', {
      patientName: 'John Doe',
      patientAge: '63',
    })

    expect(offlineNote).toContain('M17.0 — Bilateral primary osteoarthritis of knee')
    expect(offlineNote).toContain('ORDER: Bilateral hyaluronic acid knee injections requested')
    expect(offlineNote).toContain('Right Knee: Not documented this encounter.')
    expect(offlineNote).toContain('Left Knee: Not documented this encounter.')
    expect(offlineNote).not.toContain('DO NOT SIGN')
    expect(offlineNote).not.toContain('PENDING')
    expect(offlineNote).not.toContain('71020')
  })
})
