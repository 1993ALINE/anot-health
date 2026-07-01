'use strict'

jest.mock('../config/db', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  }
  const pool = {
    query: jest.fn(),
    connect: jest.fn(async () => mockClient),
  }
  pool.withTransaction = jest.fn(async (fn) => fn(mockClient))
  return pool
})

jest.mock('../utils/auditLogger', () => ({
  auditLog: jest.fn(async () => {}),
}))

jest.mock('../middleware/auth', () => ({
  invalidateUserAuthCache: jest.fn(),
}))

const pool = require('../config/db')
const { auditLog } = require('../utils/auditLogger')
const { invalidateUserAuthCache } = require('../middleware/auth')
const {
  deleteAdminUser,
  SUPER_ADMIN_EMAIL,
} = require('../controllers/adminDeleteUserController')

function mockRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function tableExistsResult(exists) {
  return { rows: exists ? [{ '?column?': 1 }] : [] }
}

describe('DELETE /api/admin/users/:userId — deleteAdminUser', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    pool.query.mockReset()
    pool.withTransaction.mockImplementation(async (fn) => fn({ query: jest.fn() }))
  })

  test('cannot delete super admin', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 2, name: 'Root Admin', email: 'root@anot.health', role: 'super_admin' }],
    })

    const req = {
      user: { id: 1, role: 'super_admin' },
      params: { userId: '2' },
    }
    const res = mockRes()

    await deleteAdminUser(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Super Admin accounts cannot be deleted.' })
    expect(pool.withTransaction).not.toHaveBeenCalled()
  })

  test('cannot delete self', async () => {
    const req = {
      user: { id: 5, role: 'super_admin' },
      params: { userId: '5' },
    }
    const res = mockRes()

    await deleteAdminUser(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'You cannot delete your own account.' })
    expect(pool.query).not.toHaveBeenCalled()
  })

  test('cannot delete protected super admin email even if role differs', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 9,
        name: 'Protected',
        email: SUPER_ADMIN_EMAIL,
        role: 'admin',
      }],
    })

    const req = {
      user: { id: 1, role: 'super_admin' },
      params: { userId: '9' },
    }
    const res = mockRes()

    await deleteAdminUser(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'This account cannot be deleted.' })
  })

  test('can delete regular user', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 10, name: 'New Clinician', email: 'new@anot.health', role: 'clinician' }],
    })

    const clientQuery = jest.fn(async (sql) => {
      if (sql.includes('information_schema.tables')) {
        return tableExistsResult(false)
      }
      if (sql.startsWith('DELETE FROM users')) {
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    pool.withTransaction.mockImplementation(async (fn) => fn({ query: clientQuery }))

    const req = {
      user: { id: 1, role: 'super_admin' },
      params: { userId: '10' },
    }
    const res = mockRes()

    await deleteAdminUser(req, res)

    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      deleted_user_id: 10,
      message: 'New Clinician has been permanently deleted.',
    })
    expect(invalidateUserAuthCache).toHaveBeenCalledWith(10)
    expect(auditLog).toHaveBeenCalled()
  })

  test('cascades delete sessions and audit logs', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 11, name: 'Test Scribe', email: 'scribe@anot.health', role: 'scribe' }],
    })

    const clientQuery = jest.fn(async (sql) => {
      if (sql.includes('information_schema.tables')) {
        return tableExistsResult(true)
      }
      return { rows: [], rowCount: 1 }
    })
    pool.withTransaction.mockImplementation(async (fn) => fn({ query: clientQuery }))

    const req = {
      user: { id: 1, role: 'super_admin' },
      params: { userId: '11' },
    }
    const res = mockRes()

    await deleteAdminUser(req, res)

    const sqlCalls = clientQuery.mock.calls.map(([sql]) => sql)
    expect(sqlCalls.some((sql) => sql.includes('DELETE FROM sessions WHERE user_id'))).toBe(true)
    expect(sqlCalls.some((sql) => sql.includes(`SET LOCAL anot.allow_audit_purge = 'on'`))).toBe(true)
    expect(sqlCalls.some((sql) => sql.includes('DELETE FROM audit_logs WHERE user_id'))).toBe(true)
    expect(sqlCalls.some((sql) => sql.includes('DELETE FROM users WHERE id'))).toBe(true)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ deleted_user_id: 11 }))
  })

  test('returns 404 when user not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] })

    const req = {
      user: { id: 1, role: 'super_admin' },
      params: { userId: '999' },
    }
    const res = mockRes()

    await deleteAdminUser(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'User not found.' })
  })
})
