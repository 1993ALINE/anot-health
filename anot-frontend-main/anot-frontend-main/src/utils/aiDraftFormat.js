/** Strip markdown formatting from AI draft text. */
function stripMarkdownFormatting(text) {
  let cleaned = text.replace(/\*\*/g, '')
  cleaned = cleaned.replace(/^#+\s*/gm, '')
  cleaned = cleaned.replace(/^-{3,}\s*$/gm, '')
  return cleaned
}

/** Remove clinical note header block (patient, MRN, visit type, date). */
function stripPatientHeaderBlock(text) {
  let cleaned = text.replace(/^(?:CLINICAL NOTE\s*)?(?:\r?\n)*/i, '')
  cleaned = cleaned.replace(
    /^(?:PATIENT\s*:\s*[^\r\n]*\r?\n)?(?:MRN\s*:\s*[^\r\n]*\r?\n)?(?:VISIT TYPE\s*:\s*[^\r\n]*\r?\n)?(?:DATE\s*:\s*[^\r\n]*\r?\n)?/i,
    '',
  )
  return cleaned
}

/** Strip markdown and patient header block from AI draft text for display. */
export function cleanAiDraftForDisplay(raw) {
  if (!raw) {return ''}
  const text = String(raw).trim()
  if (text.startsWith('[AI draft unavailable')) {return text}

  let cleaned = stripMarkdownFormatting(text)
  cleaned = stripPatientHeaderBlock(cleaned)
  return cleaned.trim()
}
