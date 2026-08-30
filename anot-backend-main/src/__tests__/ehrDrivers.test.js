const { getDriver, listSupportedTypes } = require('../services/ehrDrivers')

describe('ehrDrivers registry', () => {
  test('getDriver("tebra") resolves the Tebra driver', () => {
    const driver = getDriver('tebra')
    expect(driver.ehrType).toBe('tebra')
    expect(typeof driver.testConnection).toBe('function')
    expect(typeof driver.findOrCreatePatient).toBe('function')
    expect(typeof driver.pushEncounterNote).toBe('function')
  })

  test('getDriver throws a clear error for an unregistered type', () => {
    expect(() => getDriver('epic')).toThrow(/No EHR driver registered for type "epic"/)
  })

  test('listSupportedTypes exposes credential field metadata without secrets', () => {
    const types = listSupportedTypes()
    expect(types).toEqual([
      expect.objectContaining({
        ehrType: 'tebra',
        label: 'Tebra',
        credentialFields: expect.arrayContaining([
          expect.objectContaining({ key: 'customerKey', secret: true }),
          expect.objectContaining({ key: 'practiceId', secret: false }),
        ]),
      }),
    ])
  })
})
