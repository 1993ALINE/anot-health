jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  const { Readable } = require('stream')
  return {
    ...actual,
    createReadStream: jest.fn(() => {
      const stream = new Readable({ read() { this.push(null) } })
      return stream
    }),
  }
})

jest.mock('@deepgram/sdk', () => ({
  DeepgramClient: jest.fn().mockImplementation(() => ({
    listen: {
      v1: {
        media: {
          transcribeFile: jest.fn().mockResolvedValue({
            json: async () => ({
              metadata: { request_id: 'test-req-1' },
              results: {
                channels: [{
                  alternatives: [{
                    transcript: 'Patient reports mild chest discomfort.',
                    confidence: 0.91,
                  }],
                }],
              },
            }),
          }),
        },
      },
    },
  })),
}))

const {
  startTranscription,
  getTranscriptionStatus,
  getTranscript,
  parseDeepgramOutput,
} = require('../services/deepgramService')

describe('deepgramService', () => {
  const settings = {
    transcribe_enabled: true,
    transcribe_language: 'en-US',
    deepgram_model: 'nova-3-medical',
    deepgram_api_key: 'test-key',
  }

  test('startTranscription sync path completes job', async () => {
    const started = await startTranscription({
      type: 'file',
      filePath: '/tmp/ci-mock-audio.wav',
      settings,
      visitId: 99,
      fileSizeBytes: 1024,
    })
    expect(started).toEqual(expect.objectContaining({ requestId: 'test-req-1', async: false }))
    expect(started.transcript).toContain('chest discomfort')
    expect(getTranscriptionStatus('test-req-1').status).toBe('completed')
    expect(getTranscript('test-req-1')).toContain('chest discomfort')
  })

  test('parseDeepgramOutput handles channel transcripts', () => {
    const text = parseDeepgramOutput({
      results: { channels: [{ alternatives: [{ transcript: 'Hello doctor.' }] }] },
    })
    expect(text).toBe('Hello doctor.')
  })
})
