const { detectScribeInstructions, normalizeUnresolvableTokens } = require('../utils/instructionDetector')

describe('instructionDetector', () => {
  test('detects copy forward and insert commands from audit transcript', () => {
    const transcript = 'Please copy over prior right knee exam. Please insert a left knee, physical exam.'
    const result = detectScribeInstructions(transcript)

    expect(result.hasInstructions).toBe(true)
    expect(result.copyForwardRequested).toBe(true)
    expect(result.insertRequested).toBe(true)
    expect(result.hasPendingActions).toBe(true)
    expect(result.formattedExamPlaceholder).toContain('[COPY FORWARD from prior encounter — per dictation, action pending]')
    expect(result.formattedExamPlaceholder).toContain('[PENDING — examination to be entered]')
    expect(result.formattedExamPlaceholder).toContain('*** DO NOT SIGN — exam content outstanding ***')
    expect(result.doNotSignBanner).toBe('*** DO NOT SIGN — exam content outstanding ***')
  })

  test('detects recrelated unresolvable token and queries physician', () => {
    const transcript = 'He sustained a recrelated injury a little over a year ago.'
    const result = detectScribeInstructions(transcript)
    expect(result.hasInstructions).toBe(true)
    expect(result.unclearTokens.length).toBeGreaterThan(0)
    expect(result.unclearTokens[0].query).toBe('[UNCLEAR: recreational vs. work-related — query physician]')

    const normalized = normalizeUnresolvableTokens(transcript)
    expect(normalized).toContain('[UNCLEAR: recreational vs. work-related — query physician] injury')
  })

  test('returns false when no instructions are present', () => {
    const transcript = 'Patient presents with knee pain. Lungs clear, heart sounds normal.'
    const result = detectScribeInstructions(transcript)
    expect(result.hasInstructions).toBe(false)
    expect(result.copyForwardRequested).toBe(false)
    expect(result.insertRequested).toBe(false)
    expect(result.hasPendingActions).toBe(false)
    expect(result.formattedExamPlaceholder).toBeNull()
  })
})
