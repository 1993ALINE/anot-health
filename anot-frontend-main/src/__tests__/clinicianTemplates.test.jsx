import { describe, test, expect, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import ClinicianTemplateModal from '../components/ClinicianTemplateModal'

describe('ClinicianTemplateModal Component', () => {
  const mockTemplates = [
    {
      id: 'soap-adult',
      name: 'SOAP Note — Adult (Standard / Episodic)',
      category: 'Core Primary Care',
      icon: '🩺',
      content: 'CHIEF COMPLAINT:\n\nHPI:\n\nVITALS:\n\nPHYSICAL EXAMINATION:\n\nASSESSMENT & PLAN:\n',
    },
    {
      id: 'diabetes-cdm',
      name: 'Diabetes Mellitus Care (Diabetes Canada)',
      category: 'Chronic Disease Management (CDM)',
      icon: '🩸',
      content: 'GLYCEMIC CONTROL:\n\nDIABETIC FOOT EXAM:\n\nPLAN:\n',
    },
  ]

  test('does not render when isOpen is false', async () => {
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => {
      root.render(
        <ClinicianTemplateModal
          isOpen={false}
          onClose={() => {}}
          templates={mockTemplates}
          onSaveTemplates={() => {}}
        />
      )
    })
    expect(div.innerHTML).toBe('')
  })

  test('renders modal, templates list, and detected section badges when open', async () => {
    const div = document.createElement('div')
    const root = createRoot(div)
    await act(async () => {
      root.render(
        <ClinicianTemplateModal
          isOpen={true}
          onClose={() => {}}
          templates={mockTemplates}
          onSaveTemplates={() => {}}
          currentDoctorName="McKnight"
        />
      )
    })

    expect(div.textContent).toContain('Clinical Note Template Studio')
    expect(div.textContent).toContain('Dr. McKnight')
    expect(div.textContent).toContain('SOAP Note — Adult (Standard / Episodic)')
    expect(div.textContent).toContain('Diabetes Mellitus Care (Diabetes Canada)')
    expect(div.textContent).toContain('CHIEF COMPLAINT')
    expect(div.textContent).toContain('PHYSICAL EXAMINATION')
    expect(div.textContent).toContain('ASSESSMENT & PLAN')
  })

  test('allows creating a new custom template and saving', async () => {
    const saveSpy = vi.fn().mockResolvedValue({ templates: [] })
    const div = document.createElement('div')
    const root = createRoot(div)

    await act(async () => {
      root.render(
        <ClinicianTemplateModal
          isOpen={true}
          onClose={() => {}}
          templates={mockTemplates}
          onSaveTemplates={saveSpy}
          currentDoctorName="McKnight"
        />
      )
    })

    // Click "+ New Custom Template" button
    const newBtn = Array.from(div.querySelectorAll('button')).find((b) =>
      b.textContent.includes('New Custom Template')
    )
    expect(newBtn).toBeDefined()

    await act(async () => {
      newBtn.click()
    })

    expect(div.textContent).toContain('Custom Clinical Note Template')

    // Click "Save Templates to Profile"
    const saveBtn = Array.from(div.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Save Templates to Profile')
    )
    expect(saveBtn).toBeDefined()

    await act(async () => {
      saveBtn.click()
    })

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const savedPayload = saveSpy.mock.calls[0][0]
    expect(savedPayload.length).toBe(mockTemplates.length + 1)
  })
})
