import { describe, it, expect } from 'vitest'
import { clearPendingUploads, pendingUploadCount } from '../utils/offlineUploadQueue'

describe('offlineUploadQueue — PHI memory purge', () => {
  it('clearPendingUploads empties the in-memory queue', async () => {
    await import('../utils/offlineUploadQueue').then((m) =>
      m.queueAudioUpload({ visitId: 99, blob: new Blob(['x']), mode: 'primary' }),
    )
    expect(pendingUploadCount()).toBeGreaterThan(0)
    clearPendingUploads()
    expect(pendingUploadCount()).toBe(0)
  })
})
