const {
  resolvedAdminPortalKeysForAdmin,
  staffRoleToAdminModuleKey,
  actorMayManageUser,
  isElevatedAccount,
} = require('../utils/roles')

describe('roles utilities', () => {
  test('staffRoleToAdminModuleKey maps staff roles to portal modules', () => {
    expect(staffRoleToAdminModuleKey('clinician')).toBe('clinicians')
    expect(staffRoleToAdminModuleKey('scribe')).toBe('scribes')
    expect(staffRoleToAdminModuleKey('qps')).toBe('qps')
  })

  test('resolvedAdminPortalKeysForAdmin honors explicit module list', () => {
    const keys = resolvedAdminPortalKeysForAdmin(['audit', 'settings'])
    expect(keys).toEqual(['audit', 'settings'])
  })

  test('actorMayManageUser denies regular admin managing super_admin', () => {
    expect(actorMayManageUser('admin', { id: 2, role: 'super_admin' }, 1)).toBe(false)
  })

  test('isElevatedAccount identifies admin roles', () => {
    expect(isElevatedAccount('admin')).toBe(true)
    expect(isElevatedAccount('clinician')).toBe(false)
  })
})
