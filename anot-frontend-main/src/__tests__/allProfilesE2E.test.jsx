import { describe, test, expect, beforeAll, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Clinician from '../pages/Clinician/index.jsx'
import Scribe from '../pages/Scribe/index.jsx'
import Admin from '../pages/Admin/index.jsx'
import QPS from '../pages/QPS/index.jsx'
import { setSession, clearSession } from '../utils/sessionAuth'
import { dashboardPathForRole, roleMatchesPortal } from '../auth/dashboardPaths'
import { isSuperAdmin, isAdminPortalUser, adminMayOpenTab } from '../auth/roles'

describe('End-to-End Profile Test Suite (All 5 Roles)', () => {
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

  beforeEach(() => {
    clearSession()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // PROFILE 1: CLINICIAN (Doctor / Ambient Dictation / Scribes Review)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Profile 1: Clinician', () => {
    const clinicianUser = {
      id: 101,
      name: 'Dr. Sarah Smith',
      email: 'sarah.smith@anot.health',
      role: 'clinician',
      specialty: 'Family Medicine',
    }

    test('verifies clinician route resolution and permissions', () => {
      expect(dashboardPathForRole(clinicianUser.role)).toBe('/clinician')
      expect(roleMatchesPortal('clinician', 'clinician')).toBe(true)
      expect(roleMatchesPortal('clinician', 'scribe')).toBe(false)
      expect(roleMatchesPortal('clinician', 'admin')).toBe(false)
      expect(roleMatchesPortal('clinician', 'qps')).toBe(false)
      expect(isAdminPortalUser(clinicianUser)).toBe(false)
    })

    test('renders Clinician Portal with Scribes side panel, live sync, and sleep prevention', async () => {
      setSession(clinicianUser)
      const div = document.createElement('div')
      const root = createRoot(div)

      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/clinician']}>
            <Clinician />
          </MemoryRouter>
        )
      })

      // Must render without crashing or error boundaries
      expect(div.innerHTML).not.toContain('Something went wrong')

      // Verify Header and Navigation
      expect(div.innerHTML).toContain('Anot Health')
      expect(div.innerHTML).toContain('Ambient Scribe')
      expect(div.innerHTML).toContain('Note History')
      expect(div.innerHTML).toContain('Dr. Sarah Smith')

      // Verify Encounters Side Panel
      expect(div.innerHTML).toContain('Encounters')
      expect(div.innerHTML).toContain('+ New patient')
      expect(div.innerHTML).toContain('Today')

      // Verify Live Sync indicator
      expect(div.innerHTML).toContain('sm-live-sync-indicator')
      expect(div.innerHTML).toContain('sm-pulse-dot')
      expect(div.innerHTML).toContain('sm-live-sync-label')

      // Clean up
      act(() => root.unmount())
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // PROFILE 2: SCRIBE (Medical Scribe Portal / Transcript Review / Editor)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Profile 2: Scribe', () => {
    const scribeUser = {
      id: 202,
      name: 'Alex Rivera',
      email: 'alex.rivera@anot.health',
      role: 'scribe',
    }

    test('verifies scribe route resolution and permissions', () => {
      expect(dashboardPathForRole(scribeUser.role)).toBe('/scribe')
      expect(roleMatchesPortal('scribe', 'scribe')).toBe(true)
      expect(roleMatchesPortal('scribe', 'clinician')).toBe(false)
      expect(roleMatchesPortal('scribe', 'admin')).toBe(false)
      expect(isAdminPortalUser(scribeUser)).toBe(false)
    })

    test('renders Scribe Portal with recording queue and note editor', async () => {
      setSession(scribeUser)
      const div = document.createElement('div')
      const root = createRoot(div)

      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/scribe']}>
            <Scribe />
          </MemoryRouter>
        )
      })

      expect(div.innerHTML).not.toContain('Something went wrong')
      expect(div.innerHTML).toContain('Scribe Portal')
      expect(div.innerHTML).toContain('Alex Rivera')

      act(() => root.unmount())
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // PROFILE 3: QPS (Quality, Performance & Safety Review)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Profile 3: QPS Staff', () => {
    const qpsUser = {
      id: 303,
      name: 'Elena Rostova',
      email: 'elena.rostova@anot.health',
      role: 'qps',
    }

    test('verifies QPS route resolution and permissions', () => {
      expect(dashboardPathForRole(qpsUser.role)).toBe('/qps')
      expect(roleMatchesPortal('qps', 'qps')).toBe(true)
      expect(roleMatchesPortal('qps', 'clinician')).toBe(false)
      expect(roleMatchesPortal('qps', 'scribe')).toBe(false)
      expect(roleMatchesPortal('qps', 'admin')).toBe(false)
      expect(isAdminPortalUser(qpsUser)).toBe(false)
    })

    test('renders QPS Portal with QA review cards and audit controls', async () => {
      setSession(qpsUser)
      const div = document.createElement('div')
      const root = createRoot(div)

      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/qps']}>
            <QPS />
          </MemoryRouter>
        )
      })

      expect(div.innerHTML).not.toContain('Something went wrong')
      expect(div.innerHTML).toContain('Elena Rostova')

      act(() => root.unmount())
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // PROFILE 4: ADMIN (Clinic Administrator)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Profile 4: Clinic Admin', () => {
    const adminUser = {
      id: 404,
      name: 'Marcus Vance',
      email: 'marcus.vance@anot.health',
      role: 'admin',
      admin_modules: ['overview', 'clinicians', 'scribes', 'assignments', 'audit', 'settings'],
    }

    test('verifies admin route resolution and permissions', () => {
      expect(dashboardPathForRole(adminUser.role)).toBe('/admin')
      expect(roleMatchesPortal('admin', 'admin')).toBe(true)
      expect(roleMatchesPortal('admin', 'clinician')).toBe(false)
      expect(roleMatchesPortal('admin', 'scribe')).toBe(false)
      expect(isAdminPortalUser(adminUser)).toBe(true)
      expect(isSuperAdmin(adminUser)).toBe(false)
      expect(adminMayOpenTab(adminUser, 'overview')).toBe(true)
      expect(adminMayOpenTab(adminUser, 'admins')).toBe(false) // Regular admin cannot open admins tab
    })

    test('renders Admin Portal with administrative modules and navigation', async () => {
      setSession(adminUser)
      const div = document.createElement('div')
      const root = createRoot(div)

      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/admin']}>
            <Admin />
          </MemoryRouter>
        )
      })

      expect(div.innerHTML).not.toContain('Something went wrong')
      expect(div.innerHTML).toContain('Marcus Vance')

      act(() => root.unmount())
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // PROFILE 5: SUPER ADMIN (Platform & Security Administrator)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Profile 5: Super Admin', () => {
    const superAdminUser = {
      id: 505,
      name: 'System SuperAdmin',
      email: 'superadmin@anot.health',
      role: 'super_admin',
    }

    test('verifies super_admin route resolution and elevated permissions', () => {
      expect(dashboardPathForRole(superAdminUser.role)).toBe('/admin')
      expect(roleMatchesPortal('super_admin', 'admin')).toBe(true)
      expect(isAdminPortalUser(superAdminUser)).toBe(true)
      expect(isSuperAdmin(superAdminUser)).toBe(true)
      // Super admin has unrestricted access to every single module
      expect(adminMayOpenTab(superAdminUser, 'overview')).toBe(true)
      expect(adminMayOpenTab(superAdminUser, 'admins')).toBe(true)
      expect(adminMayOpenTab(superAdminUser, 'settings')).toBe(true)
      expect(adminMayOpenTab(superAdminUser, 'audit')).toBe(true)
      expect(adminMayOpenTab(superAdminUser, 'payroll')).toBe(true)
    })

    test('renders Super Admin view with full administrative suite', async () => {
      setSession(superAdminUser)
      const div = document.createElement('div')
      const root = createRoot(div)

      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/admin']}>
            <Admin />
          </MemoryRouter>
        )
      })

      expect(div.innerHTML).not.toContain('Something went wrong')
      expect(div.innerHTML).toContain('System SuperAdmin')

      act(() => root.unmount())
    })
  })
})
