const mockCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'CHIEF COMPLAINT:\nTest note.' }],
  usage: { input_tokens: 100, output_tokens: 50 },
})

jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }))
)

jest.mock('../services/aiSettings', () => {
  const actual = jest.requireActual('../services/aiSettings')
  return {
    ...actual,
    loadAiSettings: jest.fn(),
    getAnthropicKey: jest.fn().mockResolvedValue('test-api-key'),
  }
})

const { loadAiSettings } = require('../services/aiSettings')
const { generateAINote } = require('../utils/aiPipeline')

describe('aiPipeline model selection', () => {
  beforeEach(() => {
    mockCreate.mockClear()
  })

  const patientInfo = { patient_name: 'Jane Doe', mrn: 'MRN1', visit_type: 'Follow-up', visit_date: '2026-01-01' }
  // A long transcript that pushes the built prompt well over 5,000 characters —
  // previously this alone (with no explicit anthropic_model set) would have silently
  // switched the call to Sonnet. It must no longer have any effect on model selection.
  const longTranscript = 'Speaker 0: ' + 'patient reports ongoing knee pain during this visit. '.repeat(150)

  test('uses exactly the model configured in Admin Settings, even for a long/complex transcript', async () => {
    loadAiSettings.mockResolvedValue({ anthropic_enabled: true, anthropic_model: 'claude-haiku-4-5' })

    await generateAINote([longTranscript], patientInfo)

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001')
  })

  test('defaults to Haiku (matching the Admin Settings UI default) when nothing is explicitly configured', async () => {
    loadAiSettings.mockResolvedValue({ anthropic_enabled: true, anthropic_model: '' })

    await generateAINote([longTranscript], patientInfo)

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001')
  })

  test('respects an explicit Sonnet selection just as strictly — no silent downgrade either', async () => {
    loadAiSettings.mockResolvedValue({ anthropic_enabled: true, anthropic_model: 'claude-sonnet-4-6' })

    await generateAINote([longTranscript], patientInfo)

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.model).toBe('claude-sonnet-4-6')
  })
})
