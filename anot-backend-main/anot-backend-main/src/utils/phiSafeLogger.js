/**
 * PHI-safe logging helpers — redact sensitive fields before audit/console output.
 */

const SENSITIVE_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /api[_-]?key/i,
  /ssn/i,
  /social[_-]?security/i,
  /credit[_-]?card/i,
  /patient[_-]?name/i,
  /dob|date[_-]?of[_-]?birth/i,
  /medical[_-]?record/i,
  /diagnosis/i,
  /prescription/i,
  /phone/i,
  /email/i,
  /address/i,
  /transcript/i,
  /note[_-]?content/i,
]

function isSensitiveKey(key) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(String(key)))
}

function redactSensitiveData(obj, depth = 0) {
  if (depth > 8) return '[REDACTED]'
  if (obj == null || typeof obj !== 'object') return obj

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item, depth + 1))
  }

  const redacted = {}
  for (const key of Object.keys(obj)) {
    if (isSensitiveKey(key)) {
      redacted[key] = '[REDACTED]'
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      redacted[key] = redactSensitiveData(obj[key], depth + 1)
    } else {
      redacted[key] = obj[key]
    }
  }
  return redacted
}

function safeAuditDetails(details) {
  if (details == null) return details
  if (typeof details === 'object') {
    return JSON.stringify(redactSensitiveData(details)).slice(0, 4000)
  }
  return String(details).slice(0, 4000)
}

module.exports = { redactSensitiveData, safeAuditDetails, isSensitiveKey }
