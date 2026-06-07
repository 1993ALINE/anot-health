// ─── PASSWORD POLICY (HIPAA Phase 2) ─────────────────────────────────────────
// Mirrors the backend rules in anot-backend/src/utils/passwordPolicy.js so the
// UI can validate and show a strength meter before the request is sent.

export const MIN_LENGTH = 12

export const PASSWORD_POLICY_TEXT =
  'At least 12 characters with an uppercase letter, a lowercase letter, a number, and a special character.'

const DISALLOWED = new Set(
  [
    'password*2026',
    'password*2025',
    'password2026',
    'password2025',
    'password',
    'password1',
    'password123',
    '123456',
    '12345678',
    'qwerty',
    'letmein',
    'welcome',
    'admin123',
  ].map((s) => s.toLowerCase()),
)

export function isDisallowedPassword(password) {
  if (typeof password !== 'string') return true
  return DISALLOWED.has(password.toLowerCase().trim())
}

/**
 * Returns the individual policy checks for a password.
 * @param {string} password
 */
export function getPasswordChecks(password) {
  const pw = typeof password === 'string' ? password : ''
  return {
    length: pw.length >= MIN_LENGTH,
    uppercase: /[A-Z]/.test(pw),
    lowercase: /[a-z]/.test(pw),
    number: /[0-9]/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
  }
}

/**
 * Full validation result, including the first failing rule's message.
 * @param {string} password
 * @returns {{ valid: boolean, message: string|null, checks: object }}
 */
export function validatePassword(password) {
  const checks = getPasswordChecks(password)
  let message = null
  if (!checks.length) message = `Password must be at least ${MIN_LENGTH} characters.`
  else if (!checks.uppercase) message = 'Password must contain at least one uppercase letter.'
  else if (!checks.lowercase) message = 'Password must contain at least one lowercase letter.'
  else if (!checks.number) message = 'Password must contain at least one number.'
  else if (!checks.special) message = 'Password must contain at least one special character.'
  else if (isDisallowedPassword(password))
    message = 'This password is too common. Choose a unique password.'
  return { valid: message === null, message, checks }
}

/**
 * Strength score derived from satisfied rules + length bonus.
 * @param {string} password
 * @returns {{ score: number, label: string, color: string, percent: number }}
 *   score: 0–4
 */
export function getPasswordStrength(password) {
  const pw = typeof password === 'string' ? password : ''
  if (!pw) return { score: 0, label: 'Enter a password', color: '#D1D5DB', percent: 0 }

  const checks = getPasswordChecks(pw)
  const satisfied = Object.values(checks).filter(Boolean).length // 0–5

  let score = 0
  if (satisfied >= 2) score = 1
  if (satisfied >= 3) score = 2
  if (satisfied >= 4) score = 3
  if (satisfied === 5 && pw.length >= 16) score = 4
  else if (satisfied === 5) score = 3

  if (isDisallowedPassword(pw)) score = 0

  const meta = [
    { label: 'Very weak', color: '#EF4444' },
    { label: 'Weak', color: '#F59E0B' },
    { label: 'Fair', color: '#EAB308' },
    { label: 'Strong', color: '#22C55E' },
    { label: 'Very strong', color: '#16A34A' },
  ][score]

  return { score, label: meta.label, color: meta.color, percent: ((score + 1) / 5) * 100 }
}
