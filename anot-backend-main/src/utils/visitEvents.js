const { EventEmitter } = require('events')

class VisitEventEmitter extends EventEmitter {}

const visitEvents = new VisitEventEmitter()
// Set higher listener limit to accommodate concurrent active user connections
visitEvents.setMaxListeners(200)

/**
 * Helper to determine device type from Express request.
 * Prioritizes:
 * 1. Explicit body parameter: req.body.deviceType / req.body.device_type
 * 2. Explicit query parameter: req.query.deviceType / req.query.device_type / req.query.device
 * 3. Custom request header: X-Device-Type / x-device-type
 * 4. Standard Client Hint: Sec-CH-UA-Mobile (?1 = mobile)
 * 5. User-Agent heuristics (iOS, Android, mobile browsers, tablets)
 */
function getDeviceTypeFromRequest(req) {
  if (!req) return 'desktop'

  // 1. Explicit in body (sent by frontend login/auth payloads)
  const rawBodyType = req.body?.deviceType || req.body?.device_type
  if (typeof rawBodyType === 'string') {
    const bodyType = rawBodyType.toLowerCase().trim()
    if (bodyType === 'mobile' || bodyType === 'desktop') {
      return bodyType
    }
  }

  // 2. Query param override
  const rawQueryType = req.query?.deviceType || req.query?.device_type || req.query?.device
  if (typeof rawQueryType === 'string') {
    const queryType = rawQueryType.toLowerCase().trim()
    if (queryType === 'mobile' || queryType === 'desktop') {
      return queryType
    }
  }

  // 3. Custom headers (case-insensitive check)
  const customHeader = req.headers?.['x-device-type'] ||
                       req.headers?.['X-Device-Type'] ||
                       req.headers?.['x-client-type'] ||
                       req.headers?.['X-Client-Type']
  if (typeof customHeader === 'string') {
    const headerType = customHeader.toLowerCase().trim()
    if (headerType === 'mobile' || headerType === 'desktop') {
      return headerType
    }
  }

  const platformHeader = req.headers?.['x-platform'] || req.headers?.['X-Platform']
  if (typeof platformHeader === 'string') {
    const plat = platformHeader.toLowerCase().trim()
    if (plat === 'ios' || plat === 'android' || plat === 'mobile') {
      return 'mobile'
    }
  }

  // 4. CloudFront Edge Detection: CloudFront-Is-Mobile-Viewer / CloudFront-Is-Tablet-Viewer
  if (
    req.headers?.['cloudfront-is-mobile-viewer'] === 'true' ||
    req.headers?.['cloudfront-is-tablet-viewer'] === 'true' ||
    req.headers?.['cloudfront-is-android-viewer'] === 'true' ||
    req.headers?.['cloudfront-is-ios-viewer'] === 'true'
  ) {
    return 'mobile'
  }

  // 5. Standard Chromium Client Hint: Sec-CH-UA-Mobile (?1 = mobile, ?0 = desktop)
  if (req.headers?.['sec-ch-ua-mobile'] === '?1') {
    return 'mobile'
  }
  if (req.headers?.['sec-ch-ua-mobile'] === '?0') {
    return 'desktop'
  }

  // 6. User-Agent heuristics
  const ua = (req.headers?.['user-agent'] || '').trim()

  // Native mobile app runtimes & mobile platforms (Flutter/Dart, Android/OkHttp, iOS/CFNetwork/Darwin, etc.)
  const mobilePatterns = /Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Silk|CriOS|FxiOS|webOS|Tablet|Dart|Flutter|okhttp|CFNetwork|Darwin|Dalvik|Expo|React-Native|Anot/i
  if (mobilePatterns.test(ua)) {
    return 'mobile'
  }

  // 7. Desktop browser detection:
  // Desktop browsers always specify Windows NT, Macintosh, X11, or Linux (without Android)
  const isDesktopBrowser = /Windows NT|Macintosh|X11|(Linux(?!.*Android))/i.test(ua) &&
    !!(req.headers?.['sec-ch-ua'] || req.headers?.['sec-fetch-mode'] || req.headers?.['origin'] || req.headers?.['referer'])

  if (isDesktopBrowser) {
    return 'desktop'
  }

  // If CloudFront explicitly detected desktop viewer
  if (req.headers?.['cloudfront-is-desktop-viewer'] === 'true') {
    return 'desktop'
  }

  // 8. If request is from a native mobile client (no browser origin/referer/fetch headers and not a desktop OS)
  const hasBrowserSignatures = !!(
    req.headers?.['sec-fetch-mode'] ||
    req.headers?.['sec-ch-ua'] ||
    req.headers?.['sec-ch-ua-mobile'] ||
    req.headers?.['origin'] ||
    req.headers?.['referer']
  )
  const hasDesktopOs = /Windows NT|Macintosh|X11/i.test(ua)
  if (!hasBrowserSignatures && !hasDesktopOs) {
    // Native mobile app API request
    return 'mobile'
  }

  return 'desktop'
}

/**
 * Broadcast an event for a clinician's visits
 * @param {number|string} clinicianId
 * @param {object} payload - { type, visitId, status, action, source, visit }
 */
function emitVisitEvent(clinicianId, payload = {}) {
  if (!clinicianId) return
  const event = {
    ...payload,
    clinicianId: Number(clinicianId),
    timestamp: Date.now(),
  }
  visitEvents.emit(`clinician:${clinicianId}`, event)
  visitEvents.emit('all', event)
}

module.exports = {
  visitEvents,
  getDeviceTypeFromRequest,
  emitVisitEvent,
}
