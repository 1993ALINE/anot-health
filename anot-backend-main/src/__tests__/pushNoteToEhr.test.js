'use strict'

jest.mock('../services/ehrConnectionsService', () => ({
  getConnection: jest.fn(),
  hasCompleteCredentials: jest.fn(),
}))

jest.mock('../services/ehrDrivers', () => ({
  getDriver: jest.fn(),
}))

const ehrConnectionsService = require('../services/ehrConnectionsService')
const { getDriver } = require('../services/ehrDrivers')
const { pushNoteToEhrIfConfigured } = require('../controllers/noteController')

function makeClient(handlers) {
  return { query: jest.fn(handlers) }
}

describe('pushNoteToEhrIfConfigured', () => {
  const visit = { id: 42, patient_id: 5, clinician_id: 9, visit_date: '2026-07-28' }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('skips when the clinician has no EHR connection assigned', async () => {
    const client = makeClient(async () => ({ rows: [{ ehr_connection_id: null, ehr_provider_id: null }] }))

    const result = await pushNoteToEhrIfConfigured({ visit, finalNote: 'text', client })

    expect(result).toEqual({ skipped: true })
    expect(ehrConnectionsService.getConnection).not.toHaveBeenCalled()
  })

  test('skips when the assigned connection is disabled', async () => {
    const client = makeClient(async () => ({ rows: [{ ehr_connection_id: 1, ehr_provider_id: 'P1' }] }))
    ehrConnectionsService.getConnection.mockResolvedValue({ id: 1, ehr_type: 'tebra', enabled: false })

    const result = await pushNoteToEhrIfConfigured({ visit, finalNote: 'text', client })

    expect(result).toEqual({ skipped: true })
    expect(getDriver).not.toHaveBeenCalled()
  })

  test('skips when the connection is enabled but missing required credentials', async () => {
    const client = makeClient(async () => ({ rows: [{ ehr_connection_id: 1, ehr_provider_id: 'P1' }] }))
    ehrConnectionsService.getConnection.mockResolvedValue({ id: 1, ehr_type: 'tebra', enabled: true, credentials: {} })
    ehrConnectionsService.hasCompleteCredentials.mockReturnValue(false)

    const result = await pushNoteToEhrIfConfigured({ visit, finalNote: 'text', client })

    expect(result).toEqual({ skipped: true })
  })

  test('resolves the correct driver and pushes when fully configured', async () => {
    const credentials = { customerKey: 'ck', user: 'u', password: 'p', practiceId: '1' }
    const driver = {
      findOrCreatePatient: jest.fn().mockResolvedValue('EXT-PAT-1'),
      pushEncounterNote: jest.fn().mockResolvedValue('EXT-ENC-1'),
    }
    ehrConnectionsService.getConnection.mockResolvedValue({ id: 7, ehr_type: 'tebra', enabled: true, credentials })
    ehrConnectionsService.hasCompleteCredentials.mockReturnValue(true)
    getDriver.mockReturnValue(driver)

    const client = makeClient(jest.fn()
      .mockResolvedValueOnce({ rows: [{ ehr_connection_id: 7, ehr_provider_id: 'PROV-1' }] }) // clinician lookup
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Jane Doe', mrn: 'MRN1' }] }) // patient lookup
      .mockResolvedValueOnce({ rows: [] }) // patient_ehr_ids lookup — no mapping yet
      .mockResolvedValueOnce({ rows: [] })) // patient_ehr_ids upsert

    const result = await pushNoteToEhrIfConfigured({ visit, finalNote: 'note text', client })

    expect(getDriver).toHaveBeenCalledWith('tebra')
    expect(driver.findOrCreatePatient).toHaveBeenCalledWith({ id: 5, name: 'Jane Doe', mrn: 'MRN1' }, credentials)
    expect(driver.pushEncounterNote).toHaveBeenCalledWith({
      note: { final_note: 'note text' },
      visit: { id: 42, visit_date: '2026-07-28' },
      externalPatientId: 'EXT-PAT-1',
      externalProviderId: 'PROV-1',
      credentials,
    })
    expect(result).toEqual({ ehrConnectionId: 7, ehrEncounterId: 'EXT-ENC-1' })
  })

  test('reuses an existing external patient mapping instead of creating a new one', async () => {
    const credentials = { customerKey: 'ck', user: 'u', password: 'p', practiceId: '1' }
    const driver = {
      findOrCreatePatient: jest.fn(),
      pushEncounterNote: jest.fn().mockResolvedValue('EXT-ENC-2'),
    }
    ehrConnectionsService.getConnection.mockResolvedValue({ id: 7, ehr_type: 'tebra', enabled: true, credentials })
    ehrConnectionsService.hasCompleteCredentials.mockReturnValue(true)
    getDriver.mockReturnValue(driver)

    const client = makeClient(jest.fn()
      .mockResolvedValueOnce({ rows: [{ ehr_connection_id: 7, ehr_provider_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Jane Doe', mrn: 'MRN1' }] })
      .mockResolvedValueOnce({ rows: [{ external_patient_id: 'EXISTING-PAT' }] }))

    const result = await pushNoteToEhrIfConfigured({ visit, finalNote: 'note text', client })

    expect(driver.findOrCreatePatient).not.toHaveBeenCalled()
    expect(driver.pushEncounterNote).toHaveBeenCalledWith(expect.objectContaining({ externalPatientId: 'EXISTING-PAT' }))
    expect(result).toEqual({ ehrConnectionId: 7, ehrEncounterId: 'EXT-ENC-2' })
  })

  test('propagates a driver failure so the caller can return a 502', async () => {
    const credentials = { customerKey: 'ck', user: 'u', password: 'p', practiceId: '1' }
    const driver = {
      findOrCreatePatient: jest.fn().mockResolvedValue('EXT-PAT-1'),
      pushEncounterNote: jest.fn().mockRejectedValue(new Error('EHR API timeout')),
    }
    ehrConnectionsService.getConnection.mockResolvedValue({ id: 7, ehr_type: 'tebra', enabled: true, credentials })
    ehrConnectionsService.hasCompleteCredentials.mockReturnValue(true)
    getDriver.mockReturnValue(driver)

    const client = makeClient(jest.fn()
      .mockResolvedValueOnce({ rows: [{ ehr_connection_id: 7, ehr_provider_id: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Jane Doe', mrn: 'MRN1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }))

    await expect(pushNoteToEhrIfConfigured({ visit, finalNote: 'note text', client })).rejects.toThrow('EHR API timeout')
  })
})
