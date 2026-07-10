jest.mock('../services/mfaDelivery', () => ({
  sendMfaEmail: jest.fn(async () => ({ sent: true, channel: 'email' })),
  sendMfaSms: jest.fn(async () => ({ sent: true, channel: 'sms' })),
}))

const { sendMfaEmail, sendMfaSms } = require('../services/mfaDelivery')
const {
  generateCode,
  hashCode,
  validateDestination,
  maskDestination,
  adminRequiresMfa,
  loginRequiresMfa,
  createMfaToken,
  verifyMfaCode,
  issueAndSendCode,
  sendCodeToUser,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
} = require('../services/mfaService')

function mockPool() {
  const tokens = []
  let tokenId = 1
  return {
    tokens,
    query: jest.fn(async (sql, params) => {
      if (sql.includes('INSERT INTO mfa_tokens')) {
        const row = {
          id: tokenId++,
          user_id: params[0],
          code_hash: params[1],
          purpose: params[2],
          expires_at: params[3],
          attempts: 0,
          max_attempts: params[4],
          consumed_at: null,
          created_at: new Date(),
        }
        tokens.push(row)
        return { rows: [] }
      }
      if (sql.includes('UPDATE mfa_tokens') && sql.includes('consumed_at = NOW()') && sql.includes('purpose')) {
        tokens.forEach((t) => {
          if (t.user_id === params[0] && t.purpose === params[1] && !t.consumed_at) {
            t.consumed_at = new Date()
          }
        })
        return { rows: [] }
      }
      if (sql.includes('attempts = attempts + 1')) {
        const t = tokens.find((row) => row.id === params[0])
        if (t) t.attempts += 1
        return { rows: [] }
      }
      if (sql.includes('consumed_at = NOW() WHERE id')) {
        const t = tokens.find((row) => row.id === params[0])
        if (t) t.consumed_at = new Date()
        return { rows: [] }
      }
      if (sql.includes('FROM mfa_tokens')) {
        const [userId, purpose] = params
        const active = tokens
          .filter((t) => t.user_id === userId && t.purpose === purpose && !t.consumed_at)
          .sort((a, b) => b.id - a.id)
        return { rows: active.slice(0, 1) }
      }
      return { rows: [] }
    }),
  }
}

describe('MFA one-time codes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('generateCode returns 6 digits', () => {
    const code = generateCode()
    expect(code).toMatch(/^\d{6}$/)
  })

  test('hashCode is stable', () => {
    expect(hashCode('123456')).toBe(hashCode('123456'))
    expect(hashCode('123456')).not.toBe(hashCode('654321'))
  })

  test('validateDestination accepts email and sms', () => {
    expect(validateDestination('email', 'doc@clinic.org').ok).toBe(true)
    expect(validateDestination('sms', '5551234567').ok).toBe(true)
    expect(validateDestination('fax', '5551234567').ok).toBe(false)
  })

  test('maskDestination hides sensitive parts', () => {
    expect(maskDestination('email', 'doctor@clinic.org')).toContain('@clinic.org')
    expect(maskDestination('sms', '+15551234567')).toContain('4567')
  })

  test('sendCodeToUser routes to email or sms', async () => {
    await sendCodeToUser({ mfa_method: 'email', mfa_destination: 'a@b.co' }, '123456')
    expect(sendMfaEmail).toHaveBeenCalledWith('a@b.co', '123456')

    await sendCodeToUser({ mfa_method: 'sms', mfa_destination: '+15551234567' }, '654321')
    expect(sendMfaSms).toHaveBeenCalledWith('+15551234567', '654321')
  })

  test('issueAndSendCode delivers via configured channel', async () => {
    const pool = mockPool()
    const user = { id: 1, mfa_method: 'email', mfa_destination: 'user@test.local' }
    const result = await issueAndSendCode(pool, user, 'login')
    expect(result.sent).toBe(true)
    expect(sendMfaEmail).toHaveBeenCalled()
    expect(pool.tokens).toHaveLength(1)
  })

  test('verifyMfaCode accepts valid code', async () => {
    const pool = mockPool()
    const userId = 42
    const { code } = await createMfaToken(pool, userId, 'login')
    const ok = await verifyMfaCode(pool, userId, 'login', code)
    expect(ok.ok).toBe(true)
  })

  test('verifyMfaCode rejects invalid code and tracks attempts', async () => {
    const pool = mockPool()
    const userId = 7
    await createMfaToken(pool, userId, 'login')
    const first = await verifyMfaCode(pool, userId, 'login', '000000')
    expect(first.ok).toBe(false)
    expect(first.attemptsRemaining).toBe(MAX_ATTEMPTS - 1)
  })

  test('verifyMfaCode locks after max attempts', async () => {
    const pool = mockPool()
    const userId = 9
    await createMfaToken(pool, userId, 'login')
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await verifyMfaCode(pool, userId, 'login', '000000')
    }
    const locked = await verifyMfaCode(pool, userId, 'login', '000000')
    expect(locked.ok).toBe(false)
    expect(locked.locked).toBe(true)
  })

  test('verifyMfaCode rejects expired code', async () => {
    const pool = mockPool()
    const userId = 3
    const { code } = await createMfaToken(pool, userId, 'login')
    pool.tokens[0].expires_at = new Date(Date.now() - 1000)
    const result = await verifyMfaCode(pool, userId, 'login', code)
    expect(result.ok).toBe(false)
    expect(result.expired).toBe(true)
  })

  test('CODE_TTL_MS is 10 minutes', () => {
    expect(CODE_TTL_MS).toBe(10 * 60 * 1000)
  })
})

describe('MFA policy helpers', () => {
  const savedMfaDisabled = process.env.MFA_DISABLED

  beforeEach(() => {
    delete process.env.MFA_DISABLED
  })

  afterAll(() => {
    if (savedMfaDisabled === undefined) {
      delete process.env.MFA_DISABLED
    } else {
      process.env.MFA_DISABLED = savedMfaDisabled
    }
  })

  test('adminRequiresMfa for PHI roles without MFA enabled', () => {
    expect(adminRequiresMfa('admin', false)).toBe(true)
    expect(adminRequiresMfa('admin', true)).toBe(false)
    expect(adminRequiresMfa('clinician', false)).toBe(true)
    expect(adminRequiresMfa('receptionist', false)).toBe(false)
  })

  test('loginRequiresMfa for PHI roles with email/SMS MFA', () => {
    const enrolled = {
      role: 'clinician',
      mfa_enabled: true,
      mfa_method: 'email',
      mfa_destination: 'doc@clinic.org',
    }
    expect(loginRequiresMfa(enrolled)).toBe(true)
    expect(loginRequiresMfa({ role: 'clinician', mfa_enabled: false })).toBe('ENROLLMENT_REQUIRED')
    expect(loginRequiresMfa({ role: 'clinician', mfa_enabled: true })).toBe('ENROLLMENT_REQUIRED')
    expect(loginRequiresMfa({ role: 'receptionist', mfa_enabled: false })).toBe(false)
  })

  test('loginRequiresMfa skips all gates when MFA_DISABLED=true', () => {
    process.env.MFA_DISABLED = 'true'
    const enrolled = {
      role: 'clinician',
      mfa_enabled: true,
      mfa_method: 'email',
      mfa_destination: 'doc@clinic.org',
    }
    expect(loginRequiresMfa(enrolled)).toBe(false)
    expect(loginRequiresMfa({ role: 'clinician', mfa_enabled: false })).toBe(false)
    expect(adminRequiresMfa('clinician', false)).toBe(false)
  })
})
