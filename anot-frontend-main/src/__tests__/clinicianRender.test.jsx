import { describe, test, expect, beforeAll } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Clinician from '../pages/Clinician/index.jsx'
import Scribe from '../pages/Scribe/index.jsx'
import Admin from '../pages/Admin/index.jsx'
import QPS from '../pages/QPS/index.jsx'

describe('Clinician and Scribe Render Test', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {},
      }),
    })
  })
  test('renders Clinician without throwing', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 23, name: 'Celina Provencio', role: 'clinician' }))
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Clinician />
        </MemoryRouter>
      )
    })
    expect(div.innerHTML).not.toContain('Something went wrong')
  })

  test('renders Scribe without throwing', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 9, name: 'Shahib Hasib', role: 'scribe' }))
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Scribe />
        </MemoryRouter>
      )
    })
    expect(div.innerHTML).not.toContain('Something went wrong')
  })

  test('renders Admin without throwing', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 6, name: 'Atiqur Rahman', role: 'admin' }))
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Admin />
        </MemoryRouter>
      )
    })
    expect(div.innerHTML).not.toContain('Something went wrong')
  })

  test('renders QPS without throwing', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 7, name: 'Quality Officer', role: 'qps' }))
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QPS />
        </MemoryRouter>
      )
    })
    expect(div.innerHTML).not.toContain('Something went wrong')
  })
})
