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

  test('does not duplicate Plan items into Diagnoses when Assessment & Plan is one combined header with trailing ICD-10/CPT sections', async () => {
    const div = document.createElement('div')
    const root = createRoot(div)

    // Reproduces the real annual-checkup note that surfaced the bug: a single "ASSESSMENT &
    // PLAN" header containing "Assessment" and "Plan" sub-lists, followed by ICD-10 CODES and
    // CPT CODES sections (both containing digits, which broke the old regex-based parser).
    const sampleNote = `CHIEF COMPLAINT:
Annual health checkup.

HISTORY OF PRESENT ILLNESS:
She is a 39-year-old obese female here for her annual health checkup.

VITAL SIGNS:
Not documented this encounter.

PHYSICAL EXAMINATION (PE):
Not documented this encounter.

ASSESSMENT & PLAN (A&P):
Assessment
1. Obesity
2. Type 2 diabetes mellitus, controlled on current regimen
3. Anemia (hemoglobin 11.2, hematocrit 32)
4. Dyslipidemia with elevated LDL, HDL, and cholesterol levels

Plan
1. Continue metformin 500 mg for diabetes management.
2. Patient counseled to follow a healthy diet regimen to address dyslipidemia and weight management.
3. Follow-up appointment in 6 months for repeat evaluation.

ICD-10 CODES:
E78.5 Lipidemia, unspecified
E11.9 Type 2 diabetes mellitus without complications
E66.9 Obesity, unspecified
D64.9 Anemia, unspecified

CPT CODES:
99214 Office or other outpatient visit for the evaluation and management of an established patient; moderate complexity`

    await act(async () => {
      root.render(
        <NoteSummaryModal
          isOpen={true}
          onClose={() => {}}
          patient={{ patient_name: 'Annual Checkup Patient', mrn: 'MRN-867081', visit_type: 'Follow-up' }}
          clinician={{ name: 'Dr. Test' }}
          noteText={sampleNote}
        />
      )
    })

    const html = div.innerHTML
    // Diagnoses must contain the actual diagnoses, never the "& PLAN" leftover or the word
    // "Assessment" itself, and never ICD-10/CPT code lines or Plan items.
    expect(html).toContain('Obesity')
    expect(html).not.toContain('& PLAN<')
    expect(html).not.toContain('>Assessment<')
    expect(html).not.toContain('ICD-10 CODES')
    expect(html).not.toContain('CPT CODES')
    // Plan items (metformin, diet counseling, follow-up) must appear exactly once each —
    // not once under diagnoses and again under plan.
    expect((html.match(/Continue metformin 500 mg/g) || []).length).toBe(1)
    expect((html.match(/Follow-up appointment in 6 months/g) || []).length).toBe(1)
    expect(html).not.toContain('E78.5')
    expect(html).not.toContain('99214')
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
