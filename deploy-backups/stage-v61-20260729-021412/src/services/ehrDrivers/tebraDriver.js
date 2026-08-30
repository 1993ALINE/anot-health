const tebraService = require('../tebraService')

/**
 * Adapter from the generic EHR driver interface (used by ehrConnectionsService /
 * noteController) onto the existing Tebra SOAP client in tebraService.js.
 * Kept as a thin wrapper so the (already tested) Tebra logic doesn't need to
 * change — only the parameter names are generalized at this boundary.
 */

async function testConnection(credentials) {
  return tebraService.testConnection(credentials)
}

/** @returns {Promise<string>} the external (Tebra) patient id */
async function findOrCreatePatient(patient, credentials) {
  return tebraService.findOrCreatePatient(patient, credentials)
}

/** @returns {Promise<string>} the external (Tebra) encounter id */
async function pushEncounterNote({ note, visit, externalPatientId, externalProviderId, credentials }) {
  return tebraService.pushEncounterNote({
    note,
    visit: { ...visit, tebra_provider_id: externalProviderId },
    tebraPatientId: externalPatientId,
    credentials,
  })
}

async function pullAppointments({ externalProviderId, dateFrom, dateTo }, credentials) {
  return tebraService.pullAppointments({ providerId: externalProviderId, dateFrom, dateTo }, credentials)
}

async function pullPatients({ updatedSince } = {}, credentials) {
  return tebraService.pullPatients({ updatedSince }, credentials)
}

function getCircuitStatus() {
  return tebraService.getTebraCircuitStatus()
}

module.exports = {
  ehrType: 'tebra',
  label: 'Tebra',
  credentialFields: [
    { key: 'customerKey', label: 'Customer Key', secret: true },
    { key: 'user', label: 'User', secret: true },
    { key: 'password', label: 'Password', secret: true },
    { key: 'practiceId', label: 'Practice ID', secret: false },
  ],
  testConnection,
  findOrCreatePatient,
  pushEncounterNote,
  pullAppointments,
  pullPatients,
  getCircuitStatus,
}
