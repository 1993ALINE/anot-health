const KNOWN_MEDICAL_HEADERS = new Set([
  'CHIEF COMPLAINT', 'CC', 'REASON FOR VISIT', 'CHIEF CONCERN',
  'HISTORY OF PRESENT ILLNESS', 'HISTORY OF PRESENT ILLNESS (HPI)', 'HPI',
  'PAST MEDICAL HISTORY', 'PAST MEDICAL HISTORY (PMH)', 'PMH',
  'PAST SURGICAL HISTORY', 'PAST SURGICAL HISTORY (PSH)', 'PSH',
  'MEDICATIONS', 'CURRENT MEDICATIONS', 'MEDICATION LIST',
  'ALLERGIES', 'ALLERGIES & INTOLERANCES', 'ALLERGIES AND INTOLERANCES',
  'FAMILY HISTORY', 'FAMILY HISTORY (FH)', 'FAMILY MEDICAL HISTORY', 'FH',
  'SOCIAL HISTORY', 'SOCIAL HISTORY (SH)', 'SH',
  'REVIEW OF SYSTEMS', 'REVIEW OF SYSTEMS (ROS)', 'ROS',
  'VITAL SIGNS', 'VITALS',
  'PHYSICAL EXAMINATION', 'PHYSICAL EXAM', 'PE',
  'IMAGING', 'IMAGING & DIAGNOSTICS', 'IMAGING AND DIAGNOSTICS', 'DIAGNOSTICS', 'DIAGNOSTIC STUDIES', 'LABS', 'LABORATORY DATA',
  'ASSESSMENT & PLAN', 'ASSESSMENT & PLAN (A&P)', 'ASSESSMENT AND PLAN', 'ASSESSMENT AND PLAN (A&P)', 'A&P',
  'ASSESSMENT', 'PLAN', 'IMPRESSION',
  'ICD-10 CODES', 'ICD-10', 'ICD-10 DIAGNOSES', 'DIAGNOSES', 'DIAGNOSIS', 'ICD CODES',
  'CPT CODES', 'CPT', 'BILLING CODES', 'CPT / BILLING CODES', 'PROCEDURE CODES',
  'SUBJECTIVE', 'OBJECTIVE', 'FOLLOW-UP', 'FOLLOW UP', 'INSTRUCTIONS', 'PATIENT INSTRUCTIONS', 'DISPOSITION',
])

export function isHeaderLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 80) {
    return false
  }

  // Markdown header: # Section, ## Section
  if (/^#{1,4}\s+\S+/.test(trimmed)) {
    return true
  }

  // Trailing colon: "Chief Complaint:", "HPI:"
  if (trimmed.endsWith(':')) {
    return true
  }

  const clean = trimmed.replace(/^#{1,4}\s+/, '').replace(/:$/, '').trim()
  const cleanUpper = clean.toUpperCase()

  // Matches medical section dictionary
  if (KNOWN_MEDICAL_HEADERS.has(cleanUpper)) {
    return true
  }

  // All-caps section title line without sentence punctuation (., ?, !)
  if (
    clean.length >= 2 &&
    clean.length <= 60 &&
    !/[.,;?!]$/.test(clean) &&
    clean === cleanUpper &&
    /^[A-Z0-9\s()&/\\-]+$/.test(clean)
  ) {
    return true
  }

  return false
}

/** Parse clinical text into an ordered list of { label, body } sections. */
export function parseNote(text) {
  const raw = String(text || '').trim()
  if (!raw) {
    return []
  }

  const lines = raw.split('\n')
  const headerIdx = []
  lines.forEach((line, i) => {
    if (isHeaderLine(line)) {
      headerIdx.push(i)
    }
  })

  if (headerIdx.length === 0) {
    return [{ label: '', body: raw }]
  }

  const sections = []

  // If there is preamble text before the first section header
  if (headerIdx[0] > 0) {
    const preamble = lines.slice(0, headerIdx[0]).join('\n').trim()
    if (preamble) {
      sections.push({ label: 'OVERVIEW', body: preamble })
    }
  }

  for (let i = 0; i < headerIdx.length; i += 1) {
    const start = headerIdx[i]
    const end = i + 1 < headerIdx.length ? headerIdx[i + 1] : lines.length
    const label = lines[start].trim().replace(/^#{1,4}\s+/, '').replace(/:$/, '')
    const body = lines.slice(start + 1, end).join('\n').trim()
    sections.push({ label, body })
  }
  return sections
}

export function buildNote(sections) {
  return sections
    .map((s) => (s.label ? `${s.label}:\n\n${s.body || ''}`.trimEnd() : s.body || ''))
    .join('\n\n')
}
