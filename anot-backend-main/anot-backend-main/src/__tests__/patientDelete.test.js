const { collectAudioPathsFromVisits } = require('../controllers/patientController')

describe('patient delete — S3 path collection', () => {
  test('collectAudioPathsFromVisits parses comma-separated paths', () => {
    const paths = collectAudioPathsFromVisits([
      { audio_file: '/uploads/v1.webm,/uploads/v2.webm' },
      { audio_file: '/uploads/v3.webm' },
    ])
    expect(paths).toEqual(['/uploads/v1.webm', '/uploads/v2.webm', '/uploads/v3.webm'])
  })

  test('collectAudioPathsFromVisits skips invalid paths', () => {
    const paths = collectAudioPathsFromVisits([
      { audio_file: '/uploads/ok.webm,../../etc/passwd,http://evil.com/x.webm' },
    ])
    expect(paths).toEqual(['/uploads/ok.webm'])
  })

  test('collectAudioPathsFromVisits handles empty/null audio_file', () => {
    expect(collectAudioPathsFromVisits([{ audio_file: null }])).toEqual([])
    expect(collectAudioPathsFromVisits([{ audio_file: '' }])).toEqual([])
  })
})
