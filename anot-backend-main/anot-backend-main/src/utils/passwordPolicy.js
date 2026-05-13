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

module.exports = { isDisallowedPassword, DISALLOWED_MSG }
