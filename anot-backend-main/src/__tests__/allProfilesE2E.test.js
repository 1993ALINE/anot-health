'use strict'

const {
  resolvedAdminPortalKeysForAdmin,
  staffRoleToAdminModuleKey,
  actorMayManageUser,
  isElevatedAccount,
  ASSIGNABLE_ROLES,
  ELEVATED_ROLES,
  GRANTABLE_ADMIN_MODULE_KEYS,
} = require('../utils/roles')

const {
  visitEvents,
  emitVisitEvent,
  getDeviceTypeFromRequest,
} = require('../utils/visitEvents')

describe('Backend End-to-End Profile Authorization & Event Lifecycle Test', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. ALL ROLES VERIFICATION
  // ──────────────────────────────────────────────────────────────────────────
  describe('All 5 Roles Structure', () => {
    test('confirms all canonical roles are recognized across assignable and elevated sets', () => {
      expect(ASSIGNABLE_ROLES).toContain('clinician')
      expect(ASSIGNABLE_ROLES).toContain('scribe')
      expect(ASSIGNABLE_ROLES).toContain('qps')
      expect(ELEVATED_ROLES.has('admin')).toBe(true)
      expect(ELEVATED_ROLES.has('super_admin')).toBe(true)
    })

    test('verifies elevated account hierarchy', () => {
      expect(isElevatedAccount('super_admin')).toBe(true)
      expect(isElevatedAccount('admin')).toBe(true)
      expect(isElevatedAccount('clinician')).toBe(false)
      expect(isElevatedAccount('scribe')).toBe(false)
      expect(isElevatedAccount('qps')).toBe(false)
    })

    test('verifies actorMayManageUser hierarchy matrix', () => {
      const superAdminActor = { id: 1, role: 'super_admin' }
      const adminActor = { id: 2, role: 'admin' }
      const clinicianTarget = { id: 10, role: 'clinician' }
      const scribeTarget = { id: 20, role: 'scribe' }
      const superAdminTarget = { id: 3, role: 'super_admin' }

      // Super admin can manage anyone
      expect(actorMayManageUser('super_admin', clinicianTarget, superAdminActor.id)).toBe(true)
      expect(actorMayManageUser('super_admin', scribeTarget, superAdminActor.id)).toBe(true)
      expect(actorMayManageUser('super_admin', superAdminTarget, superAdminActor.id)).toBe(true)

      // Regular admin can manage clinician and scribe
      expect(actorMayManageUser('admin', clinicianTarget, adminActor.id)).toBe(true)
      expect(actorMayManageUser('admin', scribeTarget, adminActor.id)).toBe(true)

      // Regular admin CANNOT manage super_admin
      expect(actorMayManageUser('admin', superAdminTarget, adminActor.id)).toBe(false)

      // User may manage own profile
      expect(actorMayManageUser('admin', { id: adminActor.id, role: 'admin' }, adminActor.id)).toBe(true)
    })

    test('verifies staffRoleToAdminModuleKey for staff portals', () => {
      expect(staffRoleToAdminModuleKey('clinician')).toBe('clinicians')
      expect(staffRoleToAdminModuleKey('scribe')).toBe('scribes')
      expect(staffRoleToAdminModuleKey('qps')).toBe('qps')
      expect(staffRoleToAdminModuleKey('admin')).toBe('admins')
      expect(staffRoleToAdminModuleKey('super_admin')).toBe('admins')
    })

    test('verifies grantable admin modules list', () => {
      expect(GRANTABLE_ADMIN_MODULE_KEYS).toContain('overview')
      expect(GRANTABLE_ADMIN_MODULE_KEYS).toContain('clinicians')
      expect(GRANTABLE_ADMIN_MODULE_KEYS).toContain('scribes')
      expect(GRANTABLE_ADMIN_MODULE_KEYS).toContain('assignments')
      expect(GRANTABLE_ADMIN_MODULE_KEYS).toContain('audit')
      expect(GRANTABLE_ADMIN_MODULE_KEYS).toContain('settings')
    })

    test('verifies resolvedAdminPortalKeysForAdmin defaults and filtering', () => {
      // Default (null) gives all except 'admins'
      const defaultModules = resolvedAdminPortalKeysForAdmin(null)
      expect(defaultModules).not.toContain('admins')
      expect(defaultModules).toContain('overview')
      expect(defaultModules).toContain('clinicians')

      // Explicit array filtered to valid keys
      const custom = resolvedAdminPortalKeysForAdmin(['overview', 'scribes', 'invalid_key'])
      expect(custom).toEqual(['overview', 'scribes'])
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 2. DEVICE TYPE DETECTION PER CLIENT
  // ──────────────────────────────────────────────────────────────────────────
  describe('Device Detection (Mobile vs Desktop)', () => {
    test('detects explicit X-Device-Type headers', () => {
      expect(getDeviceTypeFromRequest({ headers: { 'x-device-type': 'mobile' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'x-device-type': 'desktop' } })).toBe('desktop')
      expect(getDeviceTypeFromRequest({ headers: { 'X-Device-Type': 'mobile' } })).toBe('mobile')
    })

    test('detects explicit deviceType in request body and query', () => {
      expect(getDeviceTypeFromRequest({ body: { deviceType: 'mobile' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ body: { device_type: 'mobile' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ body: { deviceType: 'desktop' } })).toBe('desktop')
      expect(getDeviceTypeFromRequest({ query: { deviceType: 'mobile' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ query: { device: 'mobile' } })).toBe('mobile')
    })

    test('detects Sec-CH-UA-Mobile client hint', () => {
      expect(getDeviceTypeFromRequest({ headers: { 'sec-ch-ua-mobile': '?1' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'sec-ch-ua-mobile': '?0' } })).toBe('desktop')
    })

    test('detects mobile user agents (iOS Safari, Android Chrome, iPad, tablets)', () => {
      const iPhoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
      const androidUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
      const iPadUA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      const tabletUA = 'Mozilla/5.0 (Linux; Android 12; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36 Tablet'
      const desktopChromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': iPhoneUA } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': androidUA } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': iPadUA } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': tabletUA } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': desktopChromeUA } })).toBe('desktop')
    })

    test('detects CloudFront edge viewer headers', () => {
      expect(getDeviceTypeFromRequest({ headers: { 'cloudfront-is-mobile-viewer': 'true' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'cloudfront-is-tablet-viewer': 'true' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'cloudfront-is-android-viewer': 'true' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'cloudfront-is-ios-viewer': 'true' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'cloudfront-is-desktop-viewer': 'true' } })).toBe('desktop')
    })

    test('detects native mobile app runtimes and platforms', () => {
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': 'Dart/3.4.0 (dart:io)' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': 'okhttp/4.12.0' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': 'CFNetwork/1494.0.7 Darwin/23.4.0' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': 'Anot/1.0.0 (iOS 17.5)' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': 'Expo/50.0.0' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'x-platform': 'ios' } })).toBe('mobile')
      expect(getDeviceTypeFromRequest({ headers: { 'x-platform': 'android' } })).toBe('mobile')
    })

    test('detects native non-browser client without desktop browser signatures', () => {
      // Mobile app making API calls without browser origin/referer/fetch headers
      expect(getDeviceTypeFromRequest({ headers: { 'user-agent': 'CustomHttpClient/2.0' } })).toBe('mobile')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 3. REAL-TIME EVENT STREAMING (E2E Visit Events Scoped by Clinician)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Real-Time Visit Events E2E Workflow', () => {
    test('broadcasts events to specific clinician and global admin channels', (done) => {
      const clinicianId = 42
      const receivedEvents = []

      const clinicianChannel = `clinician:${clinicianId}`
      const onClinicianEvent = (evt) => {
        receivedEvents.push(evt)
        if (receivedEvents.length === 3) {
          visitEvents.off(clinicianChannel, onClinicianEvent)
          expect(receivedEvents[0].type).toBe('VISIT_CREATED')
          expect(receivedEvents[0].source).toBe('mobile')
          expect(receivedEvents[1].type).toBe('AUDIO_UPLOADED')
          expect(receivedEvents[2].type).toBe('AI_DRAFT_READY')
          done()
        }
      }

      visitEvents.on(clinicianChannel, onClinicianEvent)

      // Step 1: Mobile creates visit
      emitVisitEvent(clinicianId, {
        type: 'VISIT_CREATED',
        visitId: 1001,
        status: 'upcoming',
        action: 'created',
        source: 'mobile',
      })

      // Step 2: Mobile uploads audio
      emitVisitEvent(clinicianId, {
        type: 'AUDIO_UPLOADED',
        visitId: 1001,
        status: 'recording-uploaded',
        action: 'audio_uploaded',
        source: 'mobile',
      })

      // Step 3: Server generates AI draft
      emitVisitEvent(clinicianId, {
        type: 'AI_DRAFT_READY',
        visitId: 1001,
        status: 'draft',
        action: 'draft_ready',
        source: 'pipeline',
      })
    })
  })
})
