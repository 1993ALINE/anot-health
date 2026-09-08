const { EventEmitter } = require('events')

class VisitEventEmitter extends EventEmitter {}

const visitEvents = new VisitEventEmitter()
// Set higher listener limit to accommodate concurrent active user connections
visitEvents.setMaxListeners(200)

/**
 * Helper to determine device type from Express request
 */
function getDeviceTypeFromRequest(req) {
  if (!req) return 'desktop'
  const customHeader = req.headers?.['x-device-type']
  if (customHeader === 'mobile' || customHeader === 'desktop') {
    return customHeader
  }
  const ua = req.headers?.['user-agent'] || ''
  if (/Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
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
