const mockCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'CHIEF COMPLAINT:\nTest note.' }],
  usage: { input_tokens: 1200, output_tokens: 400 },
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
    loadAiSettings: jest.fn().mockResolvedValue({ anthropic_enabled: true, anthropic_model: 'claude-haiku-4-5' }),
    getAnthropicKey: jest.fn().mockResolvedValue('test-api-key'),
  }
})

// Simulates a slow/stuck RDS connection for the audit-log write — exactly the
// scenario this session hit firsthand earlier (RDS unreachable from this
// machine). trackCost is intentionally never awaited by aiPipeline.js, so this
// must not add any of its 3s delay to generateAINote's resolution time.
const SIMULATED_DB_DELAY_MS = 3000
let trackCostSettled = false
let pendingTimer = null

jest.mock('../services/claudeCostTracking', () => ({
  checkRateLimit: jest.fn(),
  checkCostLimit: jest.fn(),
  trackCost: jest.fn(() =>
    new Promise((resolve) => {
      pendingTimer = setTimeout(() => {
        trackCostSettled = true
        resolve(undefined)
      }, SIMULATED_DB_DELAY_MS)
    })
  ),
  getCostStats: jest.fn(),
  resetDailyCost: jest.fn(),
  MODEL_PRICING: {},
}))

const { generateAINote } = require('../utils/aiPipeline')

describe('generateAINote does not wait on the cost-tracking DB write', () => {
  beforeEach(() => {
    mockCreate.mockClear()
    trackCostSettled = false
  })

  afterEach(() => {
    // The 3s timer is never meant to fire in this test — clear it so it doesn't
    // dangle past the test file's completion (Jest's "did not exit" warning).
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = null
  })

  const patientInfo = { patient_name: 'Jane Doe', mrn: 'MRN1', visit_type: 'Follow-up', visit_date: '2026-01-01' }
  const transcript = 'Speaker 0: patient reports a mild headache for two days.'

  test('resolves in well under the simulated DB delay', async () => {
    const start = Date.now()
    const result = await generateAINote([transcript], patientInfo, undefined, 42)
    const elapsed = Date.now() - start

    expect(result).not.toBeNull()
    // The note must come back fast — nowhere near the 3s the (unawaited) DB write
    // takes to settle. A generous 500ms ceiling leaves headroom for CI slowness
    // while still failing hard if trackCost is ever accidentally awaited again.
    expect(elapsed).toBeLessThan(500)
    // And confirm the slow write genuinely hadn't finished yet when we returned —
    // otherwise this test would be trivially true for the wrong reason (e.g. if
    // SIMULATED_DB_DELAY_MS were 0).
    expect(trackCostSettled).toBe(false)
  })
})
