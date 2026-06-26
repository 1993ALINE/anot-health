/**
 * Decode JWT payload without verification — used only to pick the correct login
 * gate UI. The server still validates the token on every API call.
 */
export function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') {
    return null
  }
  try {
    const part = token.split('.')[1]
    if (!part) {
      return null
    }
    const padded = part.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='))
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Resolve which MFA gate to show after login / PHI ack.
 * Prefer JWT claims (authoritative) over response flags.
 * @returns {'enrollment'|'totp'|null}
 */
export function resolveMfaGateFromAuthResponse(data) {
  if (!data?.temporaryToken && !data?.requireMfa && !data?.enrollmentRequired) {
    return null
  }

  const claims = decodeJwtPayload(data.temporaryToken)
  if (claims?.requireMfaEnrollment === true) {
    return 'enrollment'
  }
  if (claims?.requireMfa === true) {
    return 'totp'
  }
  if (data.enrollmentRequired === true) {
    return 'enrollment'
  }
  if (data.requireMfa === true) {
    return 'totp'
  }
  return null
}
