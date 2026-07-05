/** Group and label multiple visits for the same patient on one day. */

function visitMinutesFromMidnight(time) {
  if (!time) return 0
  const parts = String(time).trim().split(':')
  const h = parseInt(parts[0], 10) || 0
  const m = parseInt(parts[1], 10) || 0
  return h * 60 + m
}

export function visitHasAudio(v) {
  const af = v?.audio_file
  if (!af) return false
  const s = String(af).trim()
  return s !== '' && s !== '[]' && s !== 'null'
}

export function sortVisitsByEncounter(visits) {
  return [...visits].sort((a, b) => {
    const diff = visitMinutesFromMidnight(a.visit_time) - visitMinutesFromMidnight(b.visit_time)
    if (diff !== 0) return diff
    return (a.id || 0) - (b.id || 0)
  })
}

/** @returns {Map<number, object[]>} patient_id → visits (sorted) */
export function groupVisitsByPatient(visits) {
  const map = new Map()
  for (const v of visits || []) {
    const pid = v.patient_id
    if (pid == null) continue
    if (!map.has(pid)) map.set(pid, [])
    map.get(pid).push(v)
  }
  for (const [pid, list] of map) {
    map.set(pid, sortVisitsByEncounter(list))
  }
  return map
}

export function getSiblingVisits(visit, groupMap) {
  if (!visit?.patient_id) return visit ? [visit] : []
  return groupMap.get(visit.patient_id) || [visit]
}

export function getPatientVisitIndex(visit, groupMap) {
  const list = groupMap.get(visit?.patient_id)
  if (!list || list.length <= 1) return null
  const idx = list.findIndex((v) => v.id === visit.id)
  return idx >= 0 ? idx + 1 : null
}

export function getPatientVisitTotal(visit, groupMap) {
  const list = groupMap.get(visit?.patient_id)
  return list?.length > 1 ? list.length : null
}

export function visitEncounterShortLabel(visit, index, total) {
  if (!total || total <= 1) return null
  return `Visit ${index} of ${total}`
}

export function visitEncounterTabLabel(visit, index, fmtTime) {
  const time = visit?.visit_time && fmtTime ? fmtTime(visit.visit_time) : ''
  const type = visit?.visit_type || 'Encounter'
  const base = `Visit ${index}`
  if (time) return `${base} · ${type} · ${time}`
  return `${base} · ${type}`
}
