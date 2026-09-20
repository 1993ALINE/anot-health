const { extractKeyMedicalInfo } = require('../services/claudeService')

describe('extractKeyMedicalInfo', () => {
  test('returns short transcripts unchanged (below the 50-char floor)', () => {
    expect(extractKeyMedicalInfo('too short')).toBe('too short')
    expect(extractKeyMedicalInfo('')).toBe('')
  })

  test('strips hesitation fillers without touching clinical content', () => {
    // Only um/uh/erm/er are stripped as hesitation fillers — "like" and "so" are
    // deliberately NOT stripped, since they can be clinically meaningful ("the pain
    // feels like burning") and stripping them risks garbling the sentence.
    const transcript = 'Speaker 0: The patient has, um, a fever of 101 and a mild cough.'
    const result = extractKeyMedicalInfo(transcript)
    expect(result).not.toMatch(/\bum\b/i)
    expect(result).toContain('fever of 101')
  })

  test('merges consecutive same-speaker utterances into one paragraph', () => {
    const transcript = [
      'Speaker 0: Let me take a look at your throat.',
      'Speaker 0: I see some redness.',
      'Speaker 0: No exudate though.',
    ].join('\n')
    const result = extractKeyMedicalInfo(transcript)
    // Should collapse to a single "Speaker 0:" line, not three.
    expect(result.match(/Speaker 0:/g)?.length).toBe(1)
    expect(result).toContain('Let me take a look at your throat.')
    expect(result).toContain('I see some redness.')
    expect(result).toContain('No exudate though.')
  })

  test('does not merge across different speakers', () => {
    const transcript = [
      'Speaker 0: How is the pain, 1 to 10?',
      'Speaker 1: About a 7.',
      'Speaker 0: Okay, when did it start?',
    ].join('\n')
    const result = extractKeyMedicalInfo(transcript)
    expect(result.match(/Speaker 0:/g)?.length).toBe(2)
    expect(result.match(/Speaker 1:/g)?.length).toBe(1)
    expect(result).toContain('About a 7.')
  })

  test('drops whole-line pure pleasantries with no clinical content', () => {
    // Each pleasantry is its own line (a whole-line exact match) — a line that
    // combines multiple pleasantries with a comma is intentionally NOT stripped,
    // since that's no longer an exact match to any single curated phrase (see the
    // "keeps a line that mixes small talk with clinical content" test below).
    const transcript = [
      'Speaker 0: How are you doing today?',
      'Speaker 1: I have a bad cough and chest tightness for 3 days.',
      'Speaker 0: Okay.',
      'Speaker 0: Take care.',
    ].join('\n')
    const result = extractKeyMedicalInfo(transcript)
    expect(result).not.toMatch(/how are you doing today/i)
    expect(result).not.toMatch(/take care/i)
    expect(result).toContain('bad cough and chest tightness for 3 days')
  })

  test('keeps a line that mixes small talk with clinical content (no partial-match stripping)', () => {
    const transcript = 'Speaker 0: How are you doing today, any more chest pain?'
    const result = extractKeyMedicalInfo(transcript)
    expect(result).toContain('How are you doing today, any more chest pain?')
  })

  test('collapses exact consecutive duplicate lines (ASR stutter)', () => {
    const transcript = [
      'Speaker 1: My knee hurts a lot.',
      'Speaker 1: My knee hurts a lot.',
      'Speaker 0: I understand, let\'s examine it.',
    ].join('\n')
    const result = extractKeyMedicalInfo(transcript)
    expect(result.match(/My knee hurts a lot\./g)?.length).toBe(1)
  })

  test('preserves a bare acknowledgement embedded mid-sentence (only whole-line matches are dropped)', () => {
    const transcript = 'Speaker 0: Okay, so your blood pressure today is 130 over 85.'
    const result = extractKeyMedicalInfo(transcript)
    expect(result).toContain('blood pressure today is 130 over 85')
  })

  test('caps output at 80,000 characters', () => {
    const longTranscript = 'Speaker 0: patient reports symptom. '.repeat(5000)
    const result = extractKeyMedicalInfo(longTranscript)
    expect(result.length).toBeLessThanOrEqual(80000)
  })

  test('realistic short visit: meaningfully reduces length vs. raw transcript', () => {
    const transcript = [
      'Speaker 0: Hi, how are you doing today?',
      'Speaker 1: Good, thanks.',
      'Speaker 0: So, um, what brings you in?',
      'Speaker 1: I have, like, a sore throat for two days.',
      'Speaker 0: Okay.',
      'Speaker 0: Let me take a look.',
      'Speaker 0: I see some redness in the throat.',
      'Speaker 0: No white patches.',
      'Speaker 1: Is it strep?',
      'Speaker 0: Probably viral, I will prescribe supportive care.',
      'Speaker 0: Take care, see you next time.',
    ].join('\n')
    const result = extractKeyMedicalInfo(transcript)
    expect(result.length).toBeLessThan(transcript.length)
    // Every clinical fact must survive.
    expect(result).toContain('sore throat for two days')
    expect(result).toContain('redness in the throat')
    expect(result).toContain('No white patches')
    expect(result).toContain('Probably viral')
  })
})
