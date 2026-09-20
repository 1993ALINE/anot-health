const mockCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'CHIEF COMPLAINT:\nTest note.' }],
  usage: {
    input_tokens: 1200,
    output_tokens: 400,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
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

const mockCheckRateLimit = jest.fn()
const mockCheckCostLimit = jest.fn()
const mockTrackCost = jest.fn().mockResolvedValue(undefined)

jest.mock('../services/claudeCostTracking', () => ({
  checkRateLimit: (...args) => mockCheckRateLimit(...args),
  checkCostLimit: (...args) => mockCheckCostLimit(...args),
  trackCost: (...args) => mockTrackCost(...args),
  getCostStats: jest.fn(),
  resetDailyCost: jest.fn(),
  MODEL_PRICING: {},
}))

const { loadAiSettings } = require('../services/aiSettings')
const { generateAINote } = require('../utils/aiPipeline')

describe('aiPipeline cost tracking wiring', () => {
  beforeEach(() => {
    mockCreate.mockClear()
    // .mockReset() (not .mockClear()) — a prior test's .mockImplementation(() =>
    // throw) on these two otherwise leaks into every later test in this file.
    mockCheckRateLimit.mockReset()
    mockCheckCostLimit.mockReset()
    mockTrackCost.mockReset().mockResolvedValue(undefined)
    loadAiSettings.mockResolvedValue({ anthropic_enabled: true, anthropic_model: 'claude-haiku-4-5' })
  })

  const patientInfo = { patient_name: 'Jane Doe', mrn: 'MRN1', visit_type: 'Follow-up', visit_date: '2026-01-01' }
  const transcript = 'Speaker 0: patient reports a mild headache for two days.'

  test('checks rate limit and cost limit before calling Anthropic', async () => {
    await generateAINote([transcript], patientInfo, undefined, 42)

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
    expect(mockCheckCostLimit).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  test('records real usage with the visit id and model actually used', async () => {
    await generateAINote([transcript], patientInfo, undefined, 42)

    expect(mockTrackCost).toHaveBeenCalledTimes(1)
    const [visitId, model, inputTokens, outputTokens] = mockTrackCost.mock.calls[0]
    expect(visitId).toBe(42)
    expect(model).toBe('claude-haiku-4-5-20251001')
    expect(inputTokens).toBe(1200)
    expect(outputTokens).toBe(400)
  })

  test('a thrown rate-limit error stops the note from generating (surfaces as null, like any other API failure)', async () => {
    mockCheckRateLimit.mockImplementation(() => {
      throw new Error('Rate limit exceeded: 150 calls in last minute. Max: 150/min. Wait 12s.')
    })

    const result = await generateAINote([transcript], patientInfo, undefined, 42)

    expect(result).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockTrackCost).not.toHaveBeenCalled()
  })

  test('a thrown daily-cost-limit error also stops the note from generating', async () => {
    mockCheckCostLimit.mockImplementation(() => {
      throw new Error('Daily cost limit reached: $50.0000 >= $50.00.')
    })

    const result = await generateAINote([transcript], patientInfo, undefined, 42)

    expect(result).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('works without a visitId (backward compatible with existing callers)', async () => {
    const result = await generateAINote([transcript], patientInfo)

    expect(result).not.toBeNull()
    expect(mockTrackCost).toHaveBeenCalledTimes(1)
    expect(mockTrackCost.mock.calls[0][0]).toBeUndefined()
  })
})
