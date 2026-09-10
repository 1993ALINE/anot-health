'use strict'

const { enqueueTranscription, getQueueStatus } = require('../services/transcriptionQueue')

jest.mock('../utils/aiPipeline', () => ({
  runAIPipeline: jest.fn(),
}))

const { runAIPipeline } = require('../utils/aiPipeline')

describe('transcriptionQueue service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('rejects non-integer visit ids', async () => {
    await expect(enqueueTranscription('invalid')).rejects.toThrow('Invalid visitId')
  })

  test('processes a single visit successfully', async () => {
    runAIPipeline.mockResolvedValueOnce({ success: true })
    const promise = enqueueTranscription(9901, { user: { id: 1 } })
    await expect(promise).resolves.toEqual({ success: true })
    expect(runAIPipeline).toHaveBeenCalledWith(9901, { user: { id: 1 } })
  })

  test('skips duplicate queuing for active or queued visit', async () => {
    let resolver
    runAIPipeline.mockImplementation(
      () => new Promise((resolve) => { resolver = resolve })
    )

    const p1 = enqueueTranscription(9902)
    const p2 = enqueueTranscription(9902) // duplicate

    expect(getQueueStatus().activeCount).toBeGreaterThanOrEqual(1)

    resolver({ success: true })
    await p1
    await p2

    // runAIPipeline should have been called only ONCE for visit 9902
    expect(runAIPipeline).toHaveBeenCalledTimes(1)
  })

  test('handles failure gracefully without crashing queue', async () => {
    runAIPipeline.mockRejectedValueOnce(new Error('Deepgram API timeout'))
    await expect(enqueueTranscription(9903)).rejects.toThrow('Deepgram API timeout')
    const status = getQueueStatus()
    expect(status.totalFailed).toBeGreaterThanOrEqual(1)
  })

  test('reports queue status diagnostics correctly', () => {
    const status = getQueueStatus()
    expect(status).toHaveProperty('activeCount')
    expect(status).toHaveProperty('queuedCount')
    expect(status).toHaveProperty('maxConcurrency')
    expect(status).toHaveProperty('totalProcessed')
    expect(status).toHaveProperty('totalFailed')
    expect(status.maxConcurrency).toBeGreaterThanOrEqual(1)
  })
})
