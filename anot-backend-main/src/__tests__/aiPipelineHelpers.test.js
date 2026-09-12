const { buildAnthropicNotePrompt, extractDictatedPatientDetails, cleanTranscriptForClinicalPrompt, calculateAgeFromDob } = require('../utils/aiPipelineHelpers')

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
    expect(prompt).not.toContain('IMAGING:')
    expect(prompt).toContain('ASSESSMENT & PLAN (A&P):')
    expect(prompt).toContain('ICD-10 CODES:')
    expect(prompt).toContain('CPT CODES:')
    expect(prompt).toContain('Use EXACTLY these 7 plain-text section headers')
  })

  test('falls back to the default format when given an empty template sections array', () => {
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text', [])
    expect(prompt).toContain('CHIEF COMPLAINT:')
    expect(prompt).toContain('VITAL SIGNS:')
    expect(prompt).toContain('ICD-10 CODES:')
    expect(prompt).toContain('CPT CODES:')
    expect(prompt).toContain('Use EXACTLY these 7 plain-text section headers')
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

  test('includes a calculated age in the prompt when date_of_birth is known', () => {
    const withDob = { ...patientInfo, date_of_birth: '1990-01-01' }
    const prompt = buildAnthropicNotePrompt(withDob, 'transcript text')
    const expectedAge = calculateAgeFromDob('1990-01-01')
    expect(prompt).toContain(`Age: ${expectedAge} years`)
    expect(prompt).toContain('state this age when introducing the patient')
  })

  test('instructs the model not to guess an age when date_of_birth is unknown', () => {
    const prompt = buildAnthropicNotePrompt(patientInfo, 'transcript text')
    expect(prompt).toContain('Age: not on file')
    expect(prompt).toContain('do NOT state or guess an age')
  })

  test('uses the age dictated in this visit when no date_of_birth is on file', () => {
    const withDictatedAge = { ...patientInfo, dictated_age: 63 }
    const prompt = buildAnthropicNotePrompt(withDictatedAge, 'transcript text')
    expect(prompt).toContain('Age: 63 years')
    expect(prompt).toContain('as stated by the clinician during this visit')
  })

  test('prefers the dictated age over the on-file date_of_birth when both are present', () => {
    const both = { ...patientInfo, date_of_birth: '1990-01-01', dictated_age: 63 }
    const prompt = buildAnthropicNotePrompt(both, 'transcript text')
    expect(prompt).toContain('Age: 63 years')
    expect(prompt).toContain('as stated by the clinician during this visit')
  })

  test('prioritizes adult age 63 over single digit ASR truncation 6-year-old', () => {
    const transcript = 'Patient is a 63-year-old male presenting for follow up. In assessment he is noted as a 6-year-old male with bilateral knee osteoarthritis.'
    const details = extractDictatedPatientDetails(transcript)
    expect(details.age).toBe(63)
    expect(details.gender).toBe('male')
  })

  test('injects copy-forward instruction directive when clinician commands are present', () => {
    const transcript = 'Please copy over prior right knee exam. Please insert a left knee, physical exam.'
    const prompt = buildAnthropicNotePrompt(patientInfo, transcript)
    expect(prompt).toContain('EMBEDDED SCRIBE COMMANDS DETECTED IN TRANSCRIPT:')
    expect(prompt).toContain('Right Knee: Not documented this encounter.')
    expect(prompt).toContain('Left Knee: Not documented this encounter.')
    expect(prompt).not.toContain('DO NOT SIGN')
  })
})

describe('cleanTranscriptForClinicalPrompt', () => {
  test('strips verbal fillers and acoustic tags while preserving all medical data and dosages', () => {
    const raw = 'Speaker 0: Speaker 0: [laughter] um, patient has severe right knee osteoarthritis, uh, BP is 128/82. [cough] Prescribed Meloxicam 15mg PO daily.'
    const cleaned = cleanTranscriptForClinicalPrompt(raw)

    expect(cleaned).not.toContain('[laughter]')
    expect(cleaned).not.toContain('[cough]')
    expect(cleaned).not.toContain('um,')
    expect(cleaned).not.toContain('uh,')
    expect(cleaned).toContain('Speaker 0:')
    expect(cleaned).not.toContain('Speaker 0: Speaker 0:')
    expect(cleaned).toContain('patient has severe right knee osteoarthritis')
    expect(cleaned).toContain('BP is 128/82')
    expect(cleaned).toContain('Prescribed Meloxicam 15mg PO daily')
  })

  test('handles empty or null transcripts safely', () => {
    expect(cleanTranscriptForClinicalPrompt('')).toBe('')
    expect(cleanTranscriptForClinicalPrompt(null)).toBe('')
  })
})
