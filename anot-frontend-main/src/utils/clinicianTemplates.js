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

let cachedTemplates = null
let cachePromise = null

export function clearClinicianTemplateCache() {
  cachedTemplates = null
  cachePromise = null
}

export async function loadClinicianTemplates(settingsAPI) {
  if (cachedTemplates) { return cachedTemplates }
  if (cachePromise) { return cachePromise }
  cachePromise = settingsAPI
    .getClinicianTemplates()
    .then((data) => {
      cachedTemplates = Array.isArray(data.templates) ? data.templates : []
      return cachedTemplates
    })
    .catch(() => {
      cachedTemplates = []
      return cachedTemplates
    })
    .finally(() => {
      cachePromise = null
    })
  return cachePromise
}

export async function saveClinicianTemplates(settingsAPI, templates) {
  const data = await settingsAPI.saveClinicianTemplates(templates)
  cachedTemplates = Array.isArray(data.templates) ? data.templates : templates
  return cachedTemplates
}

export function pickTemplateForVisit(templates, visitType) {
  const list = Array.isArray(templates) ? templates : []
  if (list.length === 0) { return { ...FALLBACK, visitType } }
  const id = DEFAULT_BY_TYPE[visitType]
  const match =
    (id && list.find((t) => t.id === id)) ||
    list.find((t) => t.name === visitType) ||
    list[0]
  return {
    name: match?.name || FALLBACK.name,
    content: match?.content || FALLBACK.content,
    visitType,
  }
}

export async function getClinicianTemplateForVisit(settingsAPI, visitType) {
  const templates = await loadClinicianTemplates(settingsAPI)
  return pickTemplateForVisit(templates, visitType)
}
