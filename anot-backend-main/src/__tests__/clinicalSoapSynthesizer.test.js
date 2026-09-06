const { formatClinicalDictationToSOAP, extractVitals } = require('../utils/clinicalSoapSynthesizer')

describe('clinicalSoapSynthesizer', () => {
  test('does not invent vital signs when none are dictated', () => {
    const dictation = 'Patient reports mild knee pain after tripping on a step yesterday. No other complaints.'
    const soap = formatClinicalDictationToSOAP(dictation, '', 'Follow-up', { patientName: 'John Doe', mrn: '123' })
    expect(soap).toContain('• Vital signs: Not documented / Not dictated in this encounter.')
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
    expect(soap).toContain('Focused physical examination not documented / Not dictated in this encounter.')
    expect(soap).not.toContain('PERRLA')
    expect(soap).not.toContain('Cranial nerves II-XII')
    expect(soap).not.toContain('Kernig')
  })
})
