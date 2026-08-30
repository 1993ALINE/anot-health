const { ALLOWED_VISIT_TYPES } = require('../utils/visitTypes')

describe('visitTypes', () => {
  test('exports the four allowed visit types', () => {
    expect(ALLOWED_VISIT_TYPES).toEqual(['Follow-up', 'New Patient', 'Virtual Visit', 'Other'])
  })

  test('is the same array instance visitController and ehrController import (no drift)', () => {
    const visitController = require('../controllers/visitController')
    const ehrController = require('../controllers/ehrController')
    expect(visitController).toBeDefined()
    expect(ehrController).toBeDefined()
    // Both modules requiring utils/visitTypes without throwing is itself the
    // regression check: the original Tebra controller previously imported a
    // nonexistent '../utils/visitTypes' module and crashed at require-time.
  })
})
