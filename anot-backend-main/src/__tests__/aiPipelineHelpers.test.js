const { buildAnthropicNotePrompt, extractDictatedPatientDetails } = require('../utils/aiPipelineHelpers')

const patientInfo = {
  patient_name: 'Jane Doe',
  mrn: 'MRN123',
  visit_type: 'Follow-up',
  visit_date: '2026-01-01',
}

describe('extractDictatedPatientDetails', () => {
  test('extracts patient name, MRN, and demographics from dictated speech', () => {
    const transcript = 'Patient is Michael Scott, MRN 49201. He is a 45-year-old male presenting with acute lower back pain.'
    const result = extractDictatedPatientDetails(transcript)
    expect(result).not.toBeNull()
    expect(result.name).toBe('Michael Scott')
    expect(result.mrn).toBe('49201')
    expect(result.age).toBe(45)
    expect(result.gender).toBe('male')
  })

  test('extracts dictated patient name with Patient Name is prefix', () => {
    const transcript = 'Patient name is Sarah Connor, chart number SC-882. 35yo female for annual wellness exam.'
    const result = extractDictatedPatientDetails(transcript)
    expect(result).not.toBeNull()
    expect(result.name).toBe('Sarah Connor')
    expect(result.mrn).toBe('SC-882')
    expect(result.age).toBe(35)
    expect(result.gender).toBe('female')
  })

  test('returns null when no patient dictation is present', () => {
    const transcript = 'Doctor: How are you feeling today? Patient: My knee has been hurting for two weeks.'
    const result = extractDictatedPatientDetails(transcript)
    expect(result).toBeNull()
  })
})

describe('buildAnthropicNotePrompt', () => {
  test('falls back to the default format when no template sections are given, plus coding sections', () => {
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text')
    expect(prompt).toContain('CHIEF COMPLAINT:')
    expect(prompt).toContain('HISTORY OF PRESENT ILLNESS (HPI):')
    expect(prompt).toContain('VITAL SIGNS:')
    expect(prompt).toContain('PHYSICAL EXAMINATION (PE):')
    expect(prompt).toContain('IMAGING:')
    expect(prompt).toContain('ASSESSMENT & PLAN (A&P):')
    expect(prompt).toContain('ICD-10 CODES:')
    expect(prompt).toContain('CPT CODES:')
    expect(prompt).toContain('Use EXACTLY these 8 plain-text section headers')
  })

  test('falls back to the default format when given an empty template sections array', () => {
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text', [])
    expect(prompt).toContain('CHIEF COMPLAINT:')
    expect(prompt).toContain('VITAL SIGNS:')
    expect(prompt).toContain('ICD-10 CODES:')
    expect(prompt).toContain('CPT CODES:')
    expect(prompt).toContain('Use EXACTLY these 8 plain-text section headers')
  })

  test('uses the clinician template sections, in order, and appends coding sections at the end', () => {
    const sections = ['REASON FOR VISIT', 'INTERVAL HISTORY', 'CURRENT MEDICATIONS']
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text', sections)
    expect(prompt).toContain('REASON FOR VISIT:')
    expect(prompt).toContain('INTERVAL HISTORY:')
    expect(prompt).toContain('CURRENT MEDICATIONS:')
    expect(prompt).toContain('ICD-10 CODES:')
    expect(prompt).toContain('CPT CODES:')
    expect(prompt).toContain('Use EXACTLY these 5 plain-text section headers')
    expect(prompt).not.toContain('CHIEF COMPLAINT:')
    // headers must appear in the given order, with coding sections last
    const reasonIdx = prompt.indexOf('REASON FOR VISIT:')
    const intervalIdx = prompt.indexOf('INTERVAL HISTORY:')
    const medsIdx = prompt.indexOf('CURRENT MEDICATIONS:')
    const icdIdx = prompt.indexOf('ICD-10 CODES:')
    const cptIdx = prompt.indexOf('CPT CODES:')
    expect(reasonIdx).toBeLessThan(intervalIdx)
    expect(intervalIdx).toBeLessThan(medsIdx)
    expect(medsIdx).toBeLessThan(icdIdx)
    expect(icdIdx).toBeLessThan(cptIdx)
  })

  test('does not duplicate an ICD-10 section already present in the clinician template', () => {
    const sections = ['ASSESSMENT', 'ICD-10 codes', 'E&M code based on MDM']
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text', sections)
    expect(prompt).toContain('Use EXACTLY these 3 plain-text section headers')
    expect((prompt.match(/ICD-10/gi) || []).length).toBeGreaterThan(0)
    expect(prompt).not.toContain('CPT CODES:')
  })

  test('includes coding-specific instructions for deriving codes from documented content', () => {
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text')
    expect(prompt).toContain('act as a certified medical coder')
    expect(prompt).toContain('do not upcode')
  })

  test('includes patient context and transcription', () => {
    const prompt = buildAnthropicNotePrompt(patientInfo, 'the transcript body')
    expect(prompt).toContain('Jane Doe')
    expect(prompt).toContain('MRN123')
    expect(prompt).toContain('the transcript body')
  })
})
