import { describe, it, expect, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import WorkNoteModal from '../components/WorkNoteModal'

describe('WorkNoteModal', () => {
  it('renders official work note certificate with preloaded patient details', async () => {
    const mockPatient = {
      id: 42,
      patient_name: 'David Smith',
      visit_date: '2026-09-11',
      mrn: 'MRN-397351',
    }
    const mockClinician = {
      name: 'Dr. A. McKnight',
      specialty: 'Family Physician',
    }
    const sampleNote = `CHIEF COMPLAINT:
Right foot pain and swelling.

ASSESSMENT:
Acute gout flare, right first MTP joint.

PLAN:
Colchicine and rest.`

    const div = document.createElement('div')
    const root = createRoot(div)

    await act(async () => {
      root.render(
        <WorkNoteModal
          isOpen={true}
          onClose={vi.fn()}
          patient={mockPatient}
          clinician={mockClinician}
          noteText={sampleNote}
          clinicName="Anot Health Clinic"
        />
      )
    })

    expect(div.innerHTML).toContain('Medical Work &amp; School Excuse Note')
    expect(div.innerHTML).toContain('David Smith')
    expect(div.innerHTML).toContain('MRN-397351')
    expect(div.innerHTML).toContain('Dr. A. McKnight')
    expect(div.innerHTML).toContain('Anot Health Clinic')
    expect(div.innerHTML).toContain('Off Work (Excused)')
    expect(div.innerHTML).toContain('Print Work Note')
    expect(div.innerHTML).toContain('Copy Work Note')
  })

  it('does not render when isOpen is false', async () => {
    const div = document.createElement('div')
    const root = createRoot(div)

    await act(async () => {
      root.render(
        <WorkNoteModal
          isOpen={false}
          onClose={vi.fn()}
        />
      )
    })

    expect(div.innerHTML).toBe('')
  })
})
