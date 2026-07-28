const { buildAnthropicNotePrompt } = require('../utils/aiPipelineHelpers')

const patientInfo = {
  patient_name: 'Jane Doe',
  mrn: 'MRN123',
  visit_type: 'Follow-up',
  visit_date: '2026-01-01',
}

describe('buildAnthropicNotePrompt', () => {
  test('falls back to the default 5-section format when no template sections are given', () => {
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text')
    expect(prompt).toContain('CHIEF COMPLAINT:')
    expect(prompt).toContain('HISTORY OF PRESENT ILLNESS (HPI):')
    expect(prompt).toContain('PHYSICAL EXAMINATION (PE):')
    expect(prompt).toContain('IMAGING:')
    expect(prompt).toContain('ASSESSMENT & PLAN (A&P):')
    expect(prompt).toContain('Use EXACTLY these 5 plain-text section headers')
  })

  test('falls back to the default format when given an empty template sections array', () => {
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text', [])
    expect(prompt).toContain('CHIEF COMPLAINT:')
    expect(prompt).toContain('Use EXACTLY these 5 plain-text section headers')
  })

  test('uses the clinician template sections, in order, when provided', () => {
    const sections = ['REASON FOR VISIT', 'INTERVAL HISTORY', 'CURRENT MEDICATIONS']
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text', sections)
    expect(prompt).toContain('REASON FOR VISIT:')
    expect(prompt).toContain('INTERVAL HISTORY:')
    expect(prompt).toContain('CURRENT MEDICATIONS:')
    expect(prompt).toContain('Use EXACTLY these 3 plain-text section headers')
    expect(prompt).not.toContain('CHIEF COMPLAINT:')
    // headers must appear in the given order
    const reasonIdx = prompt.indexOf('REASON FOR VISIT:')
    const intervalIdx = prompt.indexOf('INTERVAL HISTORY:')
    const medsIdx = prompt.indexOf('CURRENT MEDICATIONS:')
    expect(reasonIdx).toBeLessThan(intervalIdx)
    expect(intervalIdx).toBeLessThan(medsIdx)
  })

  test('includes patient context and transcription', () => {
    const prompt = buildAnthropicNotePrompt(patientInfo, 'the transcript body')
    expect(prompt).toContain('Jane Doe')
    expect(prompt).toContain('MRN123')
    expect(prompt).toContain('the transcript body')
  })
})
