const { applyClinicalGuardrails } = require('../utils/clinicalGuardrails')

describe('clinicalGuardrails', () => {
  test('replaces fabricated PE with clinical-record-safe copy-forward placeholder when instruction present', () => {
    const transcript = 'Please copy over prior right knee exam. Please insert a left knee, physical exam.'
    const rawNote = `
CHIEF COMPLAINT:
Bilateral knee pain

PHYSICAL EXAMINATION (PE):
Positive tenderness to palpation over the MCL joint. Positive tenderness to palpation over the lateral joint line. Positive Lachman test.

ASSESSMENT & PLAN (A&P):
1. Bilateral knee osteoarthritis.
`.trim()

    const sanitized = applyClinicalGuardrails(rawNote, transcript)
    expect(sanitized).not.toContain('Positive Lachman test')
    expect(sanitized).toContain('Right Knee: Not documented this encounter.')
    expect(sanitized).toContain('Left Knee: Not documented this encounter.')
    expect(sanitized).not.toContain('DO NOT SIGN')
    expect(sanitized).not.toContain('PENDING')
  })

  test('replaces fabricated imaging with standard gap marker when no imaging spoken', () => {
    const transcript = 'Patient presents with knee pain. No imaging performed.'
    const rawNote = `
IMAGING:
Right knee X-ray shows mild degenerative changes.
`.trim()

    const sanitized = applyClinicalGuardrails(rawNote, transcript)
    expect(sanitized).not.toContain('shows mild degenerative changes')
    expect(sanitized).toContain('None documented or ordered this encounter.')
  })

  test('strips coder deliberations and fake citations', () => {
    const transcript = 'Only his right knee was under his case.'
    const rawNote = `
IMAGING:
None.
(Note: If right knee X-rays were ordered, use 73560, transcript indicates 'right knee access' suggesting knee imaging)
`.trim()

    const sanitized = applyClinicalGuardrails(rawNote, transcript)
    expect(sanitized).not.toContain('Note: If right knee')
    expect(sanitized).not.toContain('transcript indicates')
  })

  test('replaces stacked M17.11 and M17.12 with bilateral code M17.0', () => {
    const transcript = 'Patient presents with bilateral knee osteoarthritis.'
    const rawNote = `
ICD-10 CODES:
M17.11 — Unilateral primary osteoarthritis, right knee
M17.12 — Unilateral primary osteoarthritis, left knee
`.trim()

    const sanitized = applyClinicalGuardrails(rawNote, transcript)
    expect(sanitized).toContain('M17.0 — Bilateral primary osteoarthritis of knee')
    expect(sanitized).not.toContain('M17.11')
    expect(sanitized).not.toContain('M17.12')
  })

  test('replaces acute sprain code on remote 1981 surgery with postprocedural status Z98.890', () => {
    const transcript = 'Past surgical history: Right MCL repair in 1981.'
    const rawNote = `
ICD-10 CODES:
S83.521A — Sprain of collateral ligament of right knee, initial encounter (historical 1981 MCL repair)
`.trim()

    const sanitized = applyClinicalGuardrails(rawNote, transcript)
    expect(sanitized).not.toContain('S83.521A')
    expect(sanitized).toContain('Z98.890')
  })

  test('removes retired CPT 71020 and wrong-anatomy ankle codes 73610/73600 from knee encounters', () => {
    const transcript = 'Bilateral knee pain.'
    const rawNote = `
CPT CODES:
99214 — Office or other outpatient visit (moderate-to-high complexity)
71020 — Chest X-ray, two views
73610 — Radiologic examination, ankle; 3 views
`.trim()

    const sanitized = applyClinicalGuardrails(rawNote, transcript)
    expect(sanitized).not.toContain('71020')
    expect(sanitized).not.toContain('73610')
    expect(sanitized).toContain('99214')
    expect(sanitized).toContain('moderate complexity MDM')
  })
})
