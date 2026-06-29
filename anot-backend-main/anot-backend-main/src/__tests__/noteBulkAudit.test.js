jest.mock('../utils/auditLogger', () => ({
  auditLog: jest.fn().mockResolvedValue(undefined),
  reportAuditFailure: jest.fn(),
}))

jest.mock('../utils/logger', () => ({
  logDataAccess: jest.fn(),
}))

const { auditLog } = require('../utils/auditLogger')
const cloudWatchAudit = require('../utils/logger')
const { logPhiBulkRead } = require('../controllers/noteController')

describe('noteController — PHI bulk read audit', () => {
  const req = {
    user: { id: 7, role: 'qps', email: 'qps@test.com' },
    clientIp: '127.0.0.1',
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('logPhiBulkRead writes PHI_BULK_READ audit and CloudWatch event', async () => {
    await logPhiBulkRead(req, 'note', 12, { scope: 'admin_qps_all_notes', status: 'submitted' })

    expect(auditLog).toHaveBeenCalledWith(
      req.user,
      'PHI_BULK_READ',
      'note',
      null,
      'Bulk read 12 note record(s)',
      expect.objectContaining({
        module_key: 'clinical',
        action_category: 'read',
        metadata: expect.objectContaining({ count: 12, scope: 'admin_qps_all_notes' }),
      }),
    )

    expect(cloudWatchAudit.logDataAccess).toHaveBeenCalledWith(
      7,
      'qps',
      'note',
      'bulk',
      'LIST',
      '127.0.0.1',
      expect.objectContaining({ count: 12 }),
    )
  })

  test('logPhiBulkRead supports grade resource type', async () => {
    await logPhiBulkRead(req, 'grade', 3, { scope: 'scribe_my_grades' })

    expect(auditLog).toHaveBeenCalledWith(
      req.user,
      'PHI_BULK_READ',
      'grade',
      null,
      'Bulk read 3 grade record(s)',
      expect.any(Object),
    )
  })
})
