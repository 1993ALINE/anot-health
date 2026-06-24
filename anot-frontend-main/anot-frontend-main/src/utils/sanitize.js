/**
 * HTML/text sanitization for user-generated content display.
 * Strips script tags and event handlers before rendering.
 */
const SCRIPT_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi
const ON_ATTR_RE = /\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const JAVASCRIPT_URL_RE = /javascript\s*:/gi

export function sanitizeText(input) {
  if (input === null || input === undefined) {return ''}
  return String(input)
    .replace(SCRIPT_RE, '')
    .replace(ON_ATTR_RE, '')
    .replace(JAVASCRIPT_URL_RE, '')
    .trim()
}

export function sanitizeForDisplay(input) {
  const clean = sanitizeText(input)
  return clean.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}