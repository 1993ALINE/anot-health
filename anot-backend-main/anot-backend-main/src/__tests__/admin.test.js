const { adminRequiresMfa } = require('../services/mfaService')
const {
  isSuperAdmin,
  isAdminPortal,
  actorMayManageUser,
  resolvedAdminPortalKeysForAdmin,
} = require('../utils/roles')
const { restrict } = require('../middleware/auth')

describe('admin role enforcement', () => {
  test('isSuperAdmin and isAdminPortal identify elevated roles', () => {
    expect(isSuperAdmin('super_admin')).toBe(true)
    expect(isSuperAdmin('admin')).toBe(false)
    expect(isAdminPortal('admin')).toBe(true)
    expect(isAdminPortal('clinician')).toBe(false)
  })

  test('restrict blocks non-admin from admin-only routes', () => {
    const req = { user: { role: 'clinician' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    restrict('admin', 'super_admin')(req, res, jest.fn())
    expect(res.status).toHaveBeenCalledWith(403)
  })

  test('adminRequiresMfa enforces MFA setup for PHI-access roles', () => {
    expect(adminRequiresMfa('super_admin', false)).toBe(true)
    expect(adminRequiresMfa('super_admin', true)).toBe(false)
    expect(adminRequiresMfa('clinician', false)).toBe(true)
    expect(adminRequiresMfa('scribe', false)).toBe(true)
    expect(adminRequiresMfa('qps', false)).toBe(true)
    expect(adminRequiresMfa('receptionist', false)).toBe(false)
  })
})

describe('admin portal module access', () => {
  test('resolvedAdminPortalKeysForAdmin defaults exclude admins tab', () => {
    const keys = resolvedAdminPortalKeysForAdmin(null)
    expect(keys).not.toContain('admins')
    expect(keys).toContain('audit')
  })

  test('actorMayManageUser allows super admin to manage anyone', () => {
    expect(actorMayManageUser('super_admin', { id: 5, role: 'admin' }, 1)).toBe(true)
  })
})
