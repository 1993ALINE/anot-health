import { describe, it, expect } from 'vitest'
import { isHeaderLine, parseNote } from '../utils/noteParser'

describe('ScribeFinalNoteEditor section parsing', () => {
  it('identifies medical section headers without colons', () => {
    expect(isHeaderLine('CHIEF COMPLAINT')).toBe(true)
    expect(isHeaderLine('HISTORY OF PRESENT ILLNESS (HPI)')).toBe(true)
    expect(isHeaderLine('PAST MEDICAL HISTORY')).toBe(true)
    expect(isHeaderLine('FAMILY HISTORY')).toBe(true)
    expect(isHeaderLine('SOCIAL HISTORY')).toBe(true)
    expect(isHeaderLine('REVIEW OF SYSTEMS')).toBe(true)
    expect(isHeaderLine('PHYSICAL EXAMINATION')).toBe(true)
    expect(isHeaderLine('IMAGING')).toBe(true)
    expect(isHeaderLine('ASSESSMENT & PLAN (A&P)')).toBe(true)
    expect(isHeaderLine('ICD-10 CODES')).toBe(true)
    expect(isHeaderLine('CPT CODES')).toBe(true)
  })

  it('identifies headers with colons and markdown', () => {
    expect(isHeaderLine('Chief Complaint:')).toBe(true)
    expect(isHeaderLine('## Subjective')).toBe(true)
    expect(isHeaderLine('### Assessment & Plan')).toBe(true)
  })

  it('rejects regular clinical sentence lines', () => {
    expect(isHeaderLine('Patient is a gentleman presenting today with right knee pain.')).toBe(false)
    expect(isHeaderLine('Not mentioned.')).toBe(false)
    expect(isHeaderLine('M25.561 – Pain in right knee.')).toBe(false)
  })

  it('correctly parses full note into distinct sections with labels and bodies', () => {
    const rawNote = `CHIEF COMPLAINT
Right knee pain.
HISTORY OF PRESENT ILLNESS (HPI)
Patient is a gentleman presenting today with right knee pain that began last night.
PAST MEDICAL HISTORY
Not mentioned.
FAMILY HISTORY
Not mentioned.
SOCIAL HISTORY
Not mentioned.
REVIEW OF SYSTEMS
Not mentioned.
PHYSICAL EXAMINATION
Not mentioned.
IMAGING
Not mentioned.
ASSESSMENT & PLAN (A&P)
Not mentioned.
ICD-10 CODES
M25.561 – Pain in right knee.
CPT CODES
99203 – Office or other outpatient visit.`

    const sections = parseNote(rawNote)
    expect(sections).toHaveLength(11)
    expect(sections[0].label).toBe('CHIEF COMPLAINT')
    expect(sections[0].body).toBe('Right knee pain.')
    expect(sections[1].label).toBe('HISTORY OF PRESENT ILLNESS (HPI)')
    expect(sections[1].body).toContain('Patient is a gentleman presenting today')
    expect(sections[2].label).toBe('PAST MEDICAL HISTORY')
    expect(sections[2].body).toBe('Not mentioned.')
    expect(sections[9].label).toBe('ICD-10 CODES')
    expect(sections[9].body).toBe('M25.561 – Pain in right knee.')
    expect(sections[10].label).toBe('CPT CODES')
    expect(sections[10].body).toBe('99203 – Office or other outpatient visit.')
  })
})
