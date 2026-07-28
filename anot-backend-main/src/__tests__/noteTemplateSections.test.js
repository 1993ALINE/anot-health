const { extractSectionHeaders, visitTypeToTemplateId, resolveTemplateSections } = require('../utils/noteTemplateSections')

describe('extractSectionHeaders', () => {
  test('extracts ordered headers from lines ending with a colon', () => {
    const content = 'REASON FOR VISIT:\n\n\nINTERVAL HISTORY:\n\n\nASSESSMENT & PLAN:\n'
    expect(extractSectionHeaders(content)).toEqual(['REASON FOR VISIT', 'INTERVAL HISTORY', 'ASSESSMENT & PLAN'])
  })

  test('ignores blank lines and lines without a trailing colon', () => {
    const content = 'CHIEF COMPLAINT:\nPatient reports headache\n\nHPI:\nOnset 3 days ago'
    expect(extractSectionHeaders(content)).toEqual(['CHIEF COMPLAINT', 'HPI'])
  })

  test('returns empty array for empty/missing content', () => {
    expect(extractSectionHeaders('')).toEqual([])
    expect(extractSectionHeaders(null)).toEqual([])
    expect(extractSectionHeaders(undefined)).toEqual([])
  })

  test('extracts headers underlined with dashes/em-dashes (Setext style)', () => {
    const content = [
      'History of Present Illness',
      '--------------------------',
      '',
      'Physical Exam',
      '—-------------',
      '',
      'Imaging',
      '-------',
      '',
      'Assessment/Plan',
      '----------------',
      '',
      'ICD-10 codes:',
      'S83.241A - Other tear of medial meniscus',
      '',
      'E&M code based on MDM:',
      '99213',
    ].join('\n')
    expect(extractSectionHeaders(content)).toEqual([
      'History of Present Illness',
      'Physical Exam',
      'Imaging',
      'Assessment/Plan',
      'ICD-10 codes',
      'E&M code based on MDM',
    ])
  })

  test('does not treat a long line followed by dashes as a header', () => {
    const longLine = 'x'.repeat(81)
    expect(extractSectionHeaders(`${longLine}\n---`)).toEqual([])
  })
})

describe('visitTypeToTemplateId', () => {
  test('maps known visit types to their template_id slugs', () => {
    expect(visitTypeToTemplateId('Follow-up')).toBe('follow-up')
    expect(visitTypeToTemplateId('New Patient')).toBe('new-patient')
    expect(visitTypeToTemplateId('Virtual Visit')).toBe('virtual-visit')
    expect(visitTypeToTemplateId('Other')).toBe('other')
  })

  test('handles extra whitespace and missing input', () => {
    expect(visitTypeToTemplateId('  Follow-up  ')).toBe('follow-up')
    expect(visitTypeToTemplateId(undefined)).toBe('')
  })
})

describe('resolveTemplateSections', () => {
  test('returns null when no clinicianId is provided', async () => {
    expect(await resolveTemplateSections(null, 'Follow-up')).toBeNull()
  })

  test('returns null and does not throw when the template lookup fails', async () => {
    jest.doMock('../controllers/clinicianTemplatesController', () => ({
      getTemplateForVisitType: async () => { throw new Error('boom') },
    }))
    jest.resetModules()
    const { resolveTemplateSections: resolveWithMock } = require('../utils/noteTemplateSections')
    await expect(resolveWithMock(1, 'Follow-up')).resolves.toBeNull()
    jest.dontMock('../controllers/clinicianTemplatesController')
    jest.resetModules()
  })

  test('returns headers when a matching template with content is found', async () => {
    jest.doMock('../controllers/clinicianTemplatesController', () => ({
      getTemplateForVisitType: async () => ({ id: 'follow-up', content: 'REASON FOR VISIT:\n\nASSESSMENT & PLAN:\n' }),
    }))
    jest.resetModules()
    const { resolveTemplateSections: resolveWithMock } = require('../utils/noteTemplateSections')
    await expect(resolveWithMock(1, 'Follow-up')).resolves.toEqual(['REASON FOR VISIT', 'ASSESSMENT & PLAN'])
    jest.dontMock('../controllers/clinicianTemplatesController')
    jest.resetModules()
  })
})
