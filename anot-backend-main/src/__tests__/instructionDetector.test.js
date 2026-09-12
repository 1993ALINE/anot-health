const { detectScribeInstructions, normalizeUnresolvableTokens } = require('../utils/instructionDetector')

describe('instructionDetector', () => {
  test('detects copy forward and insert commands from audit transcript', () => {
    const transcript = 'Please copy over prior right knee exam. Please insert a left knee, physical exam.'
    const result = detectScribeInstructions(transcript)

    expect(result.hasInstructions).toBe(true)
    expect(result.copyForwardRequested).toBe(true)
    expect(result.insertRequested).toBe(true)
    expect(result.hasPendingActions).toBe(true)
    // Placeholder text is written verbatim into the clinical record, so it must read as
    // documentation ("Not documented this encounter"), never as an internal workflow
    // reminder like a "DO NOT SIGN" banner.
    expect(result.formattedExamPlaceholder).toContain('Right Knee: Not documented this encounter.')
    expect(result.formattedExamPlaceholder).toContain('Left Knee: Not documented this encounter.')
    expect(result.formattedExamPlaceholder).not.toContain('DO NOT SIGN')
    expect(result.formattedExamPlaceholder).not.toContain('PENDING')
    expect(result.doNotSignBanner).toBeUndefined()
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
