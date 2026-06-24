const STORAGE_KEY = 'anot_cl_tpl'

const DEFAULT_BY_TYPE = {
  'New Patient': 'new-patient',
  'Follow-up': 'follow-up',
  'Virtual Visit': 'virtual-visit',
}

const FALLBACK = {
  name: 'General note',
  content:
    'CHIEF COMPLAINT:\n\n\nHISTORY OF PRESENT ILLNESS (HPI):\n\n\nPHYSICAL EXAMINATION:\n\n\nASSESSMENT & PLAN:\n',
}

export function getClinicianTemplateForVisit(visitType) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const list = raw ? JSON.parse(raw) : []
    if (!Array.isArray(list) || list.length === 0) {return { ...FALLBACK, visitType }}
    const id = DEFAULT_BY_TYPE[visitType]
    const match = (id && list.find((t) => t.id === id)) || list.find((t) => t.name === visitType) || list[0]
    return {
      name: match?.name || FALLBACK.name,
      content: match?.content || FALLBACK.content,
      visitType,
    }
  } catch {
    return { ...FALLBACK, visitType }
  }
}
