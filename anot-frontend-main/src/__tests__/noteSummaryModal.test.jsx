import { describe, test, expect, beforeAll } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import NoteSummaryModal from '../components/NoteSummaryModal'

describe('NoteSummaryModal', () => {
  beforeAll(() => {
    Object.defineProperty(navigator, 'clipboard', {
      writable: true,
      value: {
        writeText: async () => {},
      },
    })
  })

  test('renders clinical summary and patient instructions from note text', async () => {
    const div = document.createElement('div')
    const root = createRoot(div)

    const sampleNote = `CHIEF COMPLAINT:
Right knee pain and swelling after mechanical fall

HISTORY OF PRESENT ILLNESS:
Patient is a 45-year-old presenting with acute right knee pain.

VITAL SIGNS:
BP 120/80 · HR 72 · SpO2 99%

PHYSICAL EXAMINATION:
Moderate effusion right knee, tender along medial joint line.

ASSESSMENT:
1. Right knee contusion with acute joint effusion.
2. Rule out medial meniscus tear.

PLAN:
1. X-ray right knee completed.
2. Prescribe Meloxicam 15mg PO daily with food for 10 days.
3. Rest, Ice, Compression, Elevation (RICE).
4. Follow-up in clinic in 2 weeks or sooner if red flags develop.`

    await act(async () => {
      root.render(
        <NoteSummaryModal
          isOpen={true}
          onClose={() => {}}
          patient={{
            patient_name: 'E2E Test Patient',
            mrn: 'MRN-849201',
            visit_date: '2026-09-12',
            visit_type: 'Follow-up',
          }}
          clinician={{ name: 'Dr. Celina Provencio, MD' }}
          noteText={sampleNote}
        />
      )
    })

    expect(div.innerHTML).toContain('Encounter Summary')
    expect(div.innerHTML).toContain('E2E Test Patient')
    expect(div.innerHTML).toContain('Right knee pain and swelling after mechanical fall')
    expect(div.innerHTML).toContain('Right knee contusion with acute joint effusion')
    expect(div.innerHTML).toContain('Meloxicam 15mg')
    expect(div.innerHTML).toContain('Copy Summary')
  })

  test('does not render when isOpen is false', async () => {
    const div = document.createElement('div')
    const root = createRoot(div)

    await act(async () => {
      root.render(
        <NoteSummaryModal
          isOpen={false}
          onClose={() => {}}
          noteText="Some note"
        />
      )
    })

    expect(div.innerHTML).toBe('')
  })
})
