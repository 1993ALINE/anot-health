// ─── PASSWORD POLICY (HIPAA Phase 2) ─────────────────────────────────────────
// Single source of truth for password rules, shared by registration,
// self-service password change, and admin password reset.

const MIN_LENGTH = 12

// Human-readable summary surfaced in API errors and UI hints.
const PASSWORD_POLICY_TEXT =
  'Password must be at least 12 characters and include an uppercase letter, a lowercase letter, a number, and a special character.'

// Passwords that must never be used (previously documented defaults, top weak choices).
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

const DISALLOWED_MSG =
  'This password is not allowed (too common or a known default). Choose a unique password.'

function isDisallowedPassword(password) {
  if (password == null || typeof password !== 'string') return true
  return DISALLOWED.has(password.toLowerCase().trim())
}

/**
 * Validate a password against the full HIPAA complexity policy.
 * @param {string} password
 * @returns {{ valid: boolean, message: string|null }}
 */
function validatePassword(password) {
  if (password == null || typeof password !== 'string') {
    return { valid: false, message: 'Password is required.' }
  }
  if (password.length < MIN_LENGTH) {
    return { valid: false, message: `Password must be at least ${MIN_LENGTH} characters.` }
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter.' }
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter.' }
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number.' }
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one special character.' }
  }
  if (isDisallowedPassword(password)) {
    return { valid: false, message: DISALLOWED_MSG }
  }
  return { valid: true, message: null }
}

module.exports = {
  MIN_LENGTH,
  PASSWORD_POLICY_TEXT,
  isDisallowedPassword,
  DISALLOWED_MSG,
  validatePassword,
}
