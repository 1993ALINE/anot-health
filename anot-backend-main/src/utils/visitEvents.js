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
  const bodyType = req.body?.deviceType || req.body?.device_type
  if (bodyType === 'mobile' || bodyType === 'desktop') {
    return bodyType
  }

  // 2. Query param override
  const queryType = req.query?.deviceType || req.query?.device_type || req.query?.device
  if (queryType === 'mobile' || queryType === 'desktop') {
    return queryType
  }

  // 3. Custom header (case-insensitive check)
  const customHeader = req.headers?.['x-device-type'] || req.headers?.['X-Device-Type']
  if (customHeader === 'mobile' || customHeader === 'desktop') {
    return customHeader
  }

  // 4. Standard Chromium Client Hint: Sec-CH-UA-Mobile (?1 = mobile)
  if (req.headers?.['sec-ch-ua-mobile'] === '?1') {
    return 'mobile'
  }

  // 5. User-Agent heuristics
  const ua = req.headers?.['user-agent'] || ''
  if (/Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Silk|CriOS|FxiOS|webOS|Tablet/i.test(ua)) {
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
