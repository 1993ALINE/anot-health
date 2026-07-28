const UNDERLINE_RE = /^[-=_—–]{3,}$/

/**
 * Section-header detection shared with the frontend's `countTemplateSections`
 * convention (Clinician/index.jsx). A line counts as a header when either:
 *   - its trimmed text ends with ':' (e.g. "HISTORY OF PRESENT ILLNESS:"), or
 *   - it's immediately followed by a Setext-style underline row of dashes/equals/
 *     underscores (e.g. "History of Present Illness\n----------------"), which is
 *     how several clinicians pasted their existing note templates in.
 */
function extractSectionHeaders(content) {
  const lines = String(content || '').split('\n').map((l) => l.trim())
  const headers = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.endsWith(':')) {
      const header = line.slice(0, -1).trim()
      if (header) headers.push(header)
      continue
    }
    if (line.length <= 80 && UNDERLINE_RE.test(lines[i + 1] || '')) {
      headers.push(line)
    }
  }
  return headers
}

/** Maps a visit_type string ('Follow-up', 'New Patient', ...) to its clinician_templates.template_id slug. */
function visitTypeToTemplateId(visitType) {
  return String(visitType || '').trim().toLowerCase().replace(/\s+/g, '-')
}

/**
 * Resolve the ordered section headers from a clinician's saved template matching a visit
 * type, for AI draft generation. Null-safe: returns null (triggering the default prompt)
 * whenever there's no clinician, no matching template, or a lookup error.
 */
async function resolveTemplateSections(clinicianId, visitType, logLabel = 'noteTemplateSections') {
  if (!clinicianId) {
    console.log(`[${logLabel}] resolveTemplateSections: no clinicianId — using default prompt`)
    return null
  }
  try {
    // required lazily to avoid a require cycle (clinicianTemplatesController -> ... -> this file)
    const { getTemplateForVisitType } = require('../controllers/clinicianTemplatesController')
    const templateId = visitTypeToTemplateId(visitType)
    const template = await getTemplateForVisitType(clinicianId, visitType)
    if (!template?.content) {
      console.log(`[${logLabel}] resolveTemplateSections: clinicianId=${clinicianId} visitType=${JSON.stringify(visitType)} templateId=${templateId} -> NO TEMPLATE FOUND, using default prompt`)
      return null
    }
    const headers = extractSectionHeaders(template.content)
    console.log(`[${logLabel}] resolveTemplateSections: clinicianId=${clinicianId} visitType=${JSON.stringify(visitType)} templateId=${templateId} -> found template "${template.name}" with ${headers.length} header(s): ${JSON.stringify(headers)}`)
    return headers.length > 0 ? headers : null
  } catch (err) {
    console.warn(`[${logLabel}] Failed to resolve clinician template, falling back to default:`, err.stack || err.message)
    return null
  }
}

module.exports = { extractSectionHeaders, visitTypeToTemplateId, resolveTemplateSections }
