/** Strip markdown and patient header block from AI draft text for display. */
export function cleanAiDraftForDisplay(raw) {
  if (!raw) return ''
  const text = String(raw).trim()
  if (text.startsWith('[AI draft unavailable')) return text

  let cleaned = text.replace(/\*\*/g, '')
  cleaned = cleaned.replace(/^#+\s*/gm, '')
  cleaned = cleaned.replace(/^-{3,}\s*$/gm, '')

  cleaned = cleaned.replace(/^(?:CLINICAL NOTE\s*)?(?:\r?\n)*/i, '')
  cleaned = cleaned.replace(
    /^(?:PATIENT\s*:\s*[^\r\n]*\r?\n)?(?:MRN\s*:\s*[^\r\n]*\r?\n)?(?:VISIT TYPE\s*:\s*[^\r\n]*\r?\n)?(?:DATE\s*:\s*[^\r\n]*\r?\n)?/i,
    '',
  )

  return cleaned.trim()
}
