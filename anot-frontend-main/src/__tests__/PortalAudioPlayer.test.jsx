import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import PortalAudioPlayer from '../components/PortalAudioPlayer'
import { audioAPI } from '../services/api'

vi.mock('../services/api', () => ({
  audioAPI: {
    getCount: vi.fn(),
    getBlob: vi.fn(),
  },
}))

describe('PortalAudioPlayer', () => {
  let container
  let root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()

    // Mock URL.createObjectURL and URL.revokeObjectURL in jsdom
    if (!globalThis.URL.createObjectURL) {
      globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-audio-url')
    } else {
      vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:mock-audio-url')
    }
    if (!globalThis.URL.revokeObjectURL) {
      globalThis.URL.revokeObjectURL = vi.fn()
    } else {
      vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(() => {})
    }

    // Mock HTMLMediaElement prototype methods
    vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(function () {
      setTimeout(() => {
        this.dispatchEvent(new Event('loadedmetadata'))
      }, 10)
    })
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async function () {
      return Promise.resolve()
    })
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(function () {})
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  test('renders neutral "No recording" state immediately when hasAudio is false', async () => {
    await act(async () => {
      root.render(
        <PortalAudioPlayer
          visitId={101}
          hasAudio={false}
          durationSecs={0}
        />
      )
    })

    expect(container.textContent).toContain('No audio recorded for this encounter')
    expect(container.textContent).toContain('No recording')
    expect(container.textContent).not.toContain('Audio unavailable')
    expect(audioAPI.getCount).not.toHaveBeenCalled()
    expect(audioAPI.getBlob).not.toHaveBeenCalled()
  })

  test('renders neutral "No recording" state when audioAPI.getCount returns count: 0', async () => {
    audioAPI.getCount.mockResolvedValueOnce({ count: 0 })

    await act(async () => {
      root.render(
        <PortalAudioPlayer
          visitId={102}
          hasAudio={true}
          durationSecs={0}
        />
      )
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(container.textContent).toContain('No audio recorded for this encounter')
    expect(container.textContent).toContain('No recording')
    expect(container.textContent).not.toContain('Audio unavailable')
    expect(audioAPI.getBlob).not.toHaveBeenCalled()
  })

  test('loads recordings and displays tabs when count > 1', async () => {
    audioAPI.getCount.mockResolvedValueOnce({ count: 2 })
    audioAPI.getBlob.mockResolvedValue(new Blob(['fake-audio-bytes'], { type: 'audio/webm' }))

    await act(async () => {
      root.render(
        <PortalAudioPlayer
          visitId={103}
          hasAudio={true}
          durationSecs={60}
        />
      )
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(container.textContent).toContain('Rec 1')
    expect(container.textContent).toContain('Rec 2')
    expect(container.textContent).toContain('Recording 1 of 2')
  })

  test('displays descriptive error pill with retry button on storage 404 failure', async () => {
    audioAPI.getCount.mockResolvedValueOnce({ count: 1 })
    audioAPI.getBlob.mockRejectedValueOnce(Object.assign(new Error('Audio file not found in storage'), { status: 404 }))

    await act(async () => {
      root.render(
        <PortalAudioPlayer
          visitId={104}
          hasAudio={true}
        />
      )
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(container.textContent).toContain('Audio not found in storage · ⟳ Retry')
  })

  test('displays descriptive error pill with retry button on permission 403 failure', async () => {
    audioAPI.getCount.mockResolvedValueOnce({ count: 1 })
    audioAPI.getBlob.mockRejectedValueOnce(Object.assign(new Error('Access denied'), { status: 403 }))

    await act(async () => {
      root.render(
        <PortalAudioPlayer
          visitId={105}
          hasAudio={true}
        />
      )
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(container.textContent).toContain('Access restricted · ⟳ Retry')
  })

  test('resets active tab index and cleanly transitions when switching visits', async () => {
    // Visit 1 has 2 recordings
    audioAPI.getCount.mockResolvedValueOnce({ count: 2 })
    audioAPI.getBlob.mockResolvedValue(new Blob(['audio-visit-1'], { type: 'audio/webm' }))

    await act(async () => {
      root.render(
        <PortalAudioPlayer
          visitId={201}
          hasAudio={true}
        />
      )
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(container.textContent).toContain('Rec 1')
    expect(container.textContent).toContain('Rec 2')

    // Switch to Visit 2 which has no audio
    await act(async () => {
      root.render(
        <PortalAudioPlayer
          visitId={202}
          hasAudio={false}
        />
      )
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(container.textContent).not.toContain('Rec 1')
    expect(container.textContent).not.toContain('Rec 2')
    expect(container.textContent).toContain('No audio recorded for this encounter')
    expect(container.textContent).toContain('No recording')
  })
})
