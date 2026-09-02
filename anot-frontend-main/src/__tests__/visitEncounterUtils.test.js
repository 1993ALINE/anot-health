import {
  groupVisitsByPatient,
  getSiblingVisits,
  getPatientVisitIndex,
  visitHasAudio,
} from '../utils/visitEncounterUtils'

describe('visitEncounterUtils', () => {
  const visits = [
    { id: 402, patient_id: 138, visit_time: '15:00', audio_file: '/uploads/a.webm' },
    { id: 194, patient_id: 138, visit_time: '17:45', audio_file: '/uploads/b.webm' },
    { id: 122, patient_id: 66, visit_time: '09:00', audio_file: '/uploads/c.webm' },
  ]

  it('groups visits by patient and sorts by time', () => {
    const map = groupVisitsByPatient(visits)
    expect(map.get(138).map((v) => v.id)).toEqual([402, 194])
    expect(map.get(66).map((v) => v.id)).toEqual([122])
  })

  it('returns sibling visits for a patient', () => {
    const map = groupVisitsByPatient(visits)
    expect(getSiblingVisits({ id: 194, patient_id: 138 }, map).map((v) => v.id)).toEqual([402, 194])
  })

  it('labels visit index within patient group', () => {
    const map = groupVisitsByPatient(visits)
    expect(getPatientVisitIndex({ id: 402, patient_id: 138 }, map)).toBe(1)
    expect(getPatientVisitIndex({ id: 194, patient_id: 138 }, map)).toBe(2)
    expect(getPatientVisitIndex({ id: 122, patient_id: 66 }, map)).toBeNull()
  })

  it('detects audio on visit', () => {
    expect(visitHasAudio({ audio_file: '/uploads/x.webm' })).toBe(true)
    expect(visitHasAudio({ audio_file: '' })).toBe(false)
    expect(visitHasAudio({})).toBe(false)
  })
})
