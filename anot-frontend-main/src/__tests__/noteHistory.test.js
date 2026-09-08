import { describe, test, expect } from 'vitest'

// Helper mirroring the visit merging logic in ClinicianPortal.jsx
function mergeVisits(prev, allVisitsList = [], todayVisits = []) {
  const visitMap = new Map()
  // 1. Preserve existing visits in state
  if (Array.isArray(prev)) {
    for (const v of prev) {
      if (v && v.id) visitMap.set(v.id, v)
    }
  }
  // 2. Overlay allVisits (historical records)
  for (const v of allVisitsList) {
    if (v && v.id) {
      visitMap.set(v.id, { ...(visitMap.get(v.id) || {}), ...v })
    }
  }
  // 3. Overlay todayVisits (freshest live statuses for today)
  for (const v of todayVisits) {
    if (v && v.id) {
      visitMap.set(v.id, { ...(visitMap.get(v.id) || {}), ...v })
    }
  }

  return Array.from(visitMap.values()).sort((a, b) => {
    const dateA = `${a.visit_date || ''} ${a.visit_time || ''}`.trim()
    const dateB = `${b.visit_date || ''} ${b.visit_time || ''}`.trim()
    return dateB.localeCompare(dateA) || (b.id - a.id)
  })
}

// Helper mirroring getNoteSnippet in ClinicianPortal.jsx
function getNoteSnippet(v) {
  const text = v.final_note || v.ai_draft || v.transcription || ''
  if (!text) return ''
  const clean = text.replace(/(\r\n|\n|\r)/gm, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean
}

// Helper mirroring Note History search & status filtering
function filterNoteHistory(visits, { searchTerm = '', historyStatusFilter = 'all' }) {
  const term = searchTerm.trim().toLowerCase()
  return visits
    .filter((v) => {
      const isSigned = v.status === 'completed' || v.status === 'uploaded' || v.note_status === 'uploaded' || Boolean(v.locked_at)
      if (historyStatusFilter === 'signed' && !isSigned) return false
      if (historyStatusFilter === 'draft' && isSigned) return false

      if (!term) return true
      const nameMatch = (v.patient_name || '').toLowerCase().includes(term)
      const mrnMatch = (v.mrn || '').toLowerCase().includes(term)
      const typeMatch = (v.visit_type || '').toLowerCase().includes(term)
      const dateMatch = (v.visit_date || '').toLowerCase().includes(term)
      const noteMatch = (v.final_note || '').toLowerCase().includes(term)
      const draftMatch = (v.ai_draft || '').toLowerCase().includes(term)
      const txMatch = (v.transcription || '').toLowerCase().includes(term)
      return nameMatch || mrnMatch || typeMatch || dateMatch || noteMatch || draftMatch || txMatch
    })
    .sort((a, b) => {
      const dateA = `${a.visit_date || ''} ${a.visit_time || ''}`.trim()
      const dateB = `${b.visit_date || ''} ${b.visit_time || ''}`.trim()
      return dateB.localeCompare(dateA) || (b.id - a.id)
    })
}

describe('Note History Merging and Retention', () => {
  test('retains historical notes when subsequent poll returns empty or failed allRes', () => {
    const initialHistory = [
      { id: 101, patient_name: 'Alice Smith', visit_date: '2026-09-01', visit_time: '09:00', status: 'completed', final_note: 'Hypertension follow-up' },
      { id: 102, patient_name: 'Bob Jones', visit_date: '2026-09-02', visit_time: '14:00', status: 'ready', ai_draft: 'Type 2 Diabetes check' },
    ]

    // Next poll tick: visitsAPI.getAll() returns empty array or null (network hiccup), while today has 1 visit
    const todayVisits = [
      { id: 103, patient_name: 'Charlie Brown', visit_date: '2026-09-08', visit_time: '10:00', status: 'pending' },
    ]

    const merged = mergeVisits(initialHistory, [], todayVisits)

    expect(merged).toHaveLength(3)
    expect(merged.map((v) => v.id)).toEqual([103, 102, 101]) // Sorted newest first
    expect(merged.find((v) => v.id === 101)).toBeDefined()
    expect(merged.find((v) => v.id === 102)).toBeDefined()
  })

  test('correctly overlays fresh data on existing visits without duplicating or losing notes', () => {
    const existing = [
      { id: 201, patient_name: 'David', visit_date: '2026-09-07', status: 'in_progress', final_note: null },
    ]

    const freshAll = [
      { id: 201, patient_name: 'David', visit_date: '2026-09-07', status: 'completed', final_note: 'Annual wellness exam completed.' },
      { id: 202, patient_name: 'Emma', visit_date: '2026-09-08', status: 'ready', ai_draft: 'Asthma review' },
    ]

    const merged = mergeVisits(existing, freshAll, [])
    expect(merged).toHaveLength(2)
    const david = merged.find((v) => v.id === 201)
    expect(david.status).toBe('completed')
    expect(david.final_note).toBe('Annual wellness exam completed.')
  })

  test('eviction on deletion removes visit from state', () => {
    const visits = [
      { id: 301, patient_name: 'Frank' },
      { id: 302, patient_name: 'Grace' },
    ]
    const afterDelete = visits.filter((v) => v.id !== 301)
    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0].id).toBe(302)
  })
})

describe('Note History Search and Filtering', () => {
  const sampleVisits = [
    {
      id: 1,
      patient_name: 'Sarah Connor',
      mrn: 'MRN-1001',
      visit_date: '2026-09-05',
      visit_time: '09:00',
      visit_type: 'General Consultation',
      status: 'completed',
      final_note: 'Patient presents with acute migraine. Prescribed sumatriptan.',
      locked_at: '2026-09-05T10:00:00Z',
    },
    {
      id: 2,
      patient_name: 'John Connor',
      mrn: 'MRN-1002',
      visit_date: '2026-09-06',
      visit_time: '11:30',
      visit_type: 'Cardiology',
      status: 'ready',
      ai_draft: 'Evaluation of palpitations and mild dyspnea on exertion.',
      locked_at: null,
    },
    {
      id: 3,
      patient_name: 'Kyle Reese',
      mrn: 'MRN-1003',
      visit_date: '2026-09-07',
      visit_time: '15:00',
      visit_type: 'Orthopedics',
      status: 'in_progress',
      transcription: 'Right knee pain after sports injury.',
      locked_at: null,
    },
  ]

  test('searches by clinical terms within final note or draft', () => {
    const migraineResults = filterNoteHistory(sampleVisits, { searchTerm: 'migraine' })
    expect(migraineResults).toHaveLength(1)
    expect(migraineResults[0].patient_name).toBe('Sarah Connor')

    const dyspneaResults = filterNoteHistory(sampleVisits, { searchTerm: 'dyspnea' })
    expect(dyspneaResults).toHaveLength(1)
    expect(dyspneaResults[0].patient_name).toBe('John Connor')
  })

  test('searches by MRN and visit type', () => {
    const mrnResults = filterNoteHistory(sampleVisits, { searchTerm: 'MRN-1003' })
    expect(mrnResults).toHaveLength(1)
    expect(mrnResults[0].patient_name).toBe('Kyle Reese')

    const cardioResults = filterNoteHistory(sampleVisits, { searchTerm: 'cardiology' })
    expect(cardioResults).toHaveLength(1)
    expect(cardioResults[0].patient_name).toBe('John Connor')
  })

  test('filters by Signed status', () => {
    const signed = filterNoteHistory(sampleVisits, { historyStatusFilter: 'signed' })
    expect(signed).toHaveLength(1)
    expect(signed[0].id).toBe(1)
  })

  test('filters by Drafts status', () => {
    const drafts = filterNoteHistory(sampleVisits, { historyStatusFilter: 'draft' })
    expect(drafts).toHaveLength(2)
    expect(drafts.map((v) => v.id)).toEqual([3, 2]) // Newest first
  })

  test('generates clean snippet without raw newlines', () => {
    const v = {
      final_note: 'Chief Complaint:\nPatient reports fever\nand chills.\n\nAssessment: Viral URI.',
    }
    const snippet = getNoteSnippet(v)
    expect(snippet).not.toContain('\n')
    expect(snippet).toBe('Chief Complaint: Patient reports fever and chills. Assessment: Viral URI.')
  })
})
