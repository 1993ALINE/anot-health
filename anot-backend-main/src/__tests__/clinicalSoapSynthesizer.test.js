const { formatClinicalDictationToSOAP, extractVitals } = require('../utils/clinicalSoapSynthesizer')

describe('clinicalSoapSynthesizer', () => {
  test('does not invent vital signs when none are dictated', () => {
    const dictation = 'Patient reports mild knee pain after tripping on a step yesterday. No other complaints.'
    const soap = formatClinicalDictationToSOAP(dictation, '', 'Follow-up', { patientName: 'John Doe', mrn: '123' })
    expect(soap).toContain('• Vital signs: Not documented this encounter.')
    expect(soap).not.toContain('120/80')
    expect(soap).not.toContain('72 bpm')
    expect(soap).not.toContain('98.6')
    expect(soap).not.toContain('99%')
  })

  test('extracts only explicitly dictated vital signs', () => {
    const dictation = 'Patient presents today. Blood pressure was 138/86, heart rate 78, temperature 98.4.'
    const vitals = extractVitals(dictation)
    expect(vitals.bp).toBe('138/86 mmHg')
    expect(vitals.hr).toContain('78')
    expect(vitals.temp).toContain('98.4°F')
    expect(vitals.spo2).toBeNull()

    const soap = formatClinicalDictationToSOAP(dictation, '', 'Follow-up')
    expect(soap).toContain('• Blood Pressure: 138/86 mmHg')
    expect(soap).not.toContain('120/80')
  })

  test('does not fabricate physical exams when none are dictated', () => {
    const dictation = 'Patient called in reporting mild headache for 2 days. Resting at home.'
    const soap = formatClinicalDictationToSOAP(dictation, '', 'Follow-up')
    expect(soap).toContain('Not documented this encounter.')
    expect(soap).not.toContain('PERRLA')
    expect(soap).not.toContain('Cranial nerves II-XII')
    expect(soap).not.toContain('Kernig')
  })

  test('extracts all medications and displays them under CURRENT MEDICATIONS', () => {
    const dictation = `
Patient Arthur Pendelton presenting for bilateral knee pain and hypertension management.
Vitals: BP 134/82 mmHg, HR 72 bpm.
Medications: Lisinopril 20mg once daily, Atorvastatin 20mg at bedtime, Tylenol 500mg PRN.
Plan:
1. ORDER: Request bilateral hyaluronic acid injections.
2. Refill Lisinopril 20mg oral daily for blood pressure control.
3. Follow-up in 6 weeks.
    `.trim()

    const { extractMedications } = require('../utils/clinicalSoapSynthesizer')
    const meds = extractMedications(dictation)
    expect(meds.list).toHaveLength(3)
    expect(meds.formattedText).toContain('Lisinopril 20mg once daily')
    expect(meds.formattedText).toContain('Atorvastatin 20mg at bedtime')
    expect(meds.formattedText).toContain('Tylenol 500mg PRN')

    const soap = formatClinicalDictationToSOAP(dictation, '', 'Comprehensive Consultation', {
      patientName: 'Arthur Pendelton',
      mrn: 'MRN-30M-1234',
    })

    expect(soap).toContain('CURRENT MEDICATIONS:')
    expect(soap).toContain('• Lisinopril 20mg once daily')
    expect(soap).toContain('• Atorvastatin 20mg at bedtime')
    expect(soap).toContain('• Tylenol 500mg PRN')
    expect(soap).toContain('Refill Lisinopril 20mg oral daily for blood pressure control')
  })

  test('strictly prevents cross-section bleeding and cleans inline dictation', () => {
    const rawTranscript = `Patient Barbara McClintock, 45-year-old female presenting with headache. Chief Complaint: Dull bilateral headache towards end of day. History of Present Illness: Symptoms associated with prolonged microscope usage. Denies visual aura, nausea, or fever. Vitals: BP 120/76 mmHg, HR 72 bpm, Temp 98.4 F, SpO2 99%. Medications: Ibuprofen 400mg PRN, Acetaminophen 500mg PRN, Artificial tears 1 drop QID PRN. Physical Examination: Normal cranial nerve exam, cervical range of motion full, no temporal artery tenderness. Assessment: 1. Headache, unspecified. 2. Digital / optical eye strain. Plan: 1. Refill Ibuprofen 400mg PRN for headache relief. 2. Follow 20-20-20 screen rule. 3. Follow-up as needed.`

    const soap = formatClinicalDictationToSOAP(rawTranscript, '', 'Follow-up', {
      patientName: 'Barbara McClintock',
      patientAge: '45 yrs',
    })

    // Chief Complaint must NOT contain subsequent sections
    expect(soap).toMatch(/CHIEF COMPLAINT:\s*\nDull bilateral headache towards end of day\b/)

    // HPI must NOT contain vitals or medications
    expect(soap).toMatch(/HISTORY OF PRESENT ILLNESS \(HPI\):\s*\nSymptoms associated with prolonged microscope usage\. Denies visual aura, nausea, or fever/)

    // Current medications must only contain the 3 drugs, not physical exam
    expect(soap).toContain('• Ibuprofen 400mg PRN')
    expect(soap).toContain('• Acetaminophen 500mg PRN')
    expect(soap).toContain('• Artificial tears 1 drop QID PRN')

    // Physical exam must not contain assessment
    expect(soap).toContain('• Normal cranial nerve exam')

    // Assessment must be properly grouped
    expect(soap).toMatch(/1\. Headache, unspecified\.\s*\n2\. Digital \/ optical eye strain/)
  })

  describe('Personal Information & Non-Clinical Dictation Synthesis', () => {
    test('synthesizes a complete administrative intake note when only personal information is dictated', () => {
      const personalDictation = 'Patient name is Robert Miller, 54 years old, born August 12 1970, lives at 45 Elm Street, phone number 555-1234, married with two children, works as an accountant.'

      const note = formatClinicalDictationToSOAP(personalDictation, '', 'Follow-up')

      // Chief complaint must indicate intake & personal information documentation
      expect(note).toContain('CHIEF COMPLAINT:\nPatient Intake & Personal Information Documentation')

      // HPI must contain all personal details
      expect(note).toContain('Robert Miller')
      expect(note).toContain('54-year-old')
      expect(note).toContain('August 12 1970')
      expect(note).toContain('45 Elm Street')
      expect(note).toContain('555-1234')
      expect(note).toContain('accountant')
      expect(note).toContain('married with two children')
      expect(note).toContain('No acute medical symptoms, active complaints, or physical distress were dictated')

      // Physical examination deferred for administrative intake
      expect(note).toContain('Not documented this encounter / deferred for administrative intake.')

      // Assessment & Plan for administrative documentation
      expect(note).toContain('Encounter for administrative intake and personal demographic record documentation (Z02.89).')
      expect(note).toContain('Personal demographic profile and registration record updated in EHR.')

      // ICD-10 and CPT codes
      expect(note).toContain('Z02.89')
      expect(note).toContain('99212')
    })
  })
})

