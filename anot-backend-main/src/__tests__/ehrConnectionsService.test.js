'use strict'

jest.mock('../config/db', () => ({
  query: jest.fn(),
}))

const pool = require('../config/db')
const ehrConnectionsService = require('../services/ehrConnectionsService')

describe('ehrConnectionsService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('createConnection rejects an unregistered ehr_type', async () => {
    await expect(
      ehrConnectionsService.createConnection({ ehr_type: 'epic', name: 'Epic Main', enabled: true, credentials: {} }),
    ).rejects.toThrow(/No EHR driver registered for type "epic"/)
    expect(pool.query).not.toHaveBeenCalled()
  })

  test('createConnection encrypts credentials as a single JSON blob and getConnection decrypts them back', async () => {
    let insertedRow
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO ehr_connections')) {
        insertedRow = {
          id: 1,
          ehr_type: params[0],
          name: params[1],
          enabled: params[2],
          credentials_enc: params[3],
          config: params[4],
          created_at: new Date(),
          updated_at: new Date(),
        }
        return { rows: [insertedRow] }
      }
      if (sql.startsWith('SELECT * FROM ehr_connections WHERE id')) {
        return { rows: [insertedRow] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const credentials = { customerKey: 'ck', user: 'u', password: 'p', practiceId: '99' }
    const created = await ehrConnectionsService.createConnection({
      ehr_type: 'tebra', name: 'Tebra — Main', enabled: true, credentials,
    })

    expect(created.credentials_set).toBe(true)
    expect(created).not.toHaveProperty('credentials')

    const loaded = await ehrConnectionsService.getConnection(1)
    expect(loaded.credentials).toEqual(credentials)
  })

  test('updateConnection merges partial credential updates, keeping untouched fields', async () => {
    let row = {
      id: 2,
      ehr_type: 'tebra',
      name: 'Tebra — Old Name',
      enabled: false,
      credentials_enc: null,
      config: null,
      created_at: new Date(),
      updated_at: new Date(),
    }
    // Seed with full credentials via createConnection's encryption path first.
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('SELECT * FROM ehr_connections WHERE id')) {
        return { rows: [row] }
      }
      if (sql.startsWith('UPDATE ehr_connections')) {
        row = { ...row, name: params[0], enabled: params[1], credentials_enc: params[2] }
        return { rows: [row] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })

    // Manually seed encrypted credentials the way createConnection would.
    const { encryptString } = require('../utils/settingsEncryption')
    row.credentials_enc = encryptString(JSON.stringify({ customerKey: 'ck', user: 'u', password: 'p', practiceId: '1' }))

    const updated = await ehrConnectionsService.updateConnection(2, {
      name: 'Tebra — New Name',
      enabled: true,
      credentials: { password: 'new-password' }, // only rotate the password
    })

    expect(updated.name).toBe('Tebra — New Name')
    expect(updated.enabled).toBe(true)

    const reloaded = await ehrConnectionsService.getConnection(2)
    expect(reloaded.credentials).toEqual({ customerKey: 'ck', user: 'u', password: 'new-password', practiceId: '1' })
  })

  test('hasCompleteCredentials is false when any required field is missing', () => {
    expect(ehrConnectionsService.hasCompleteCredentials('tebra', null)).toBe(false)
    expect(ehrConnectionsService.hasCompleteCredentials('tebra', { customerKey: 'ck', user: 'u' })).toBe(false)
    expect(ehrConnectionsService.hasCompleteCredentials('tebra', {
      customerKey: 'ck', user: 'u', password: 'p', practiceId: '1',
    })).toBe(true)
  })
})
