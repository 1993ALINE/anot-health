const soap = require('soap')
const { withRetry } = require('../utils/retry')
const { createCircuitBreaker } = require('../utils/circuitBreaker')
const { withOutboundSlot } = require('../utils/outboundConcurrency')

const TEBRA_MAX_RETRIES = parseInt(process.env.TEBRA_MAX_RETRIES || '3', 10)
const tebraCircuit = createCircuitBreaker('tebra', {
  failureThreshold: parseInt(process.env.TEBRA_CIRCUIT_FAILURES || '5', 10),
  resetMs: parseInt(process.env.TEBRA_CIRCUIT_RESET_MS || '30000', 10),
})

const TEBRA_WSDL_URL = process.env.TEBRA_WSDL_URL
  || 'https://webservice.kareo.com/services/soap/2.1/KareoServices.svc?wsdl'

/**
 * SOAP operation names per Tebra's "Kareo Platform" 2.1 API. Confirm these
 * against the account's actual WSDL once credentials are available — Tebra
 * has historically changed op names across API versions, and this is the
 * only place that needs to change if they differ.
 */
const OPS = {
  getPatients: 'GetPatients',
  createPatient: 'CreatePatient',
  getAppointments: 'GetAppointments',
  createEncounter: 'CreateEncounter',
  getProviders: 'GetProviders',
}

let clientPromise = null

/** Lazily create (and cache) the SOAP client built from the WSDL. */
function getTebraClient() {
  if (!clientPromise) {
    clientPromise = soap.createClientAsync(TEBRA_WSDL_URL).catch((err) => {
      clientPromise = null // allow retry on next call rather than caching a failure forever
      throw err
    })
  }
  return clientPromise
}

function resolveTebraCredentials(settings) {
  const customerKey = settings?.tebra_customer_key || process.env.TEBRA_CUSTOMER_KEY || null
  const user = settings?.tebra_user || process.env.TEBRA_USER || null
  const password = settings?.tebra_password || process.env.TEBRA_PASSWORD || null
  const practiceId = settings?.tebra_practice_id || process.env.TEBRA_PRACTICE_ID || null
  if (!customerKey || !user || !password) return null
  return { customerKey, user, password, practiceId }
}

function requestHeader(credentials) {
  return {
    RequestHeader: {
      CustomerKey: credentials.customerKey,
      User: credentials.user,
      Password: credentials.password,
    },
  }
}

function getTebraCircuitStatus() {
  return tebraCircuit.status()
}

/** Execute a SOAP call through the shared retry/circuit-breaker/concurrency stack. */
async function callTebra(opName, args, label) {
  return tebraCircuit.exec(() => withOutboundSlot(() => withRetry(async () => {
    const client = await getTebraClient()
    const asyncOp = client[`${opName}Async`]
    if (typeof asyncOp !== 'function') {
      throw new Error(`Tebra SOAP operation not found on client: ${opName}`)
    }
    const [result] = await asyncOp(args)
    return result
  }, {
    maxAttempts: TEBRA_MAX_RETRIES,
    label: label || `Tebra ${opName}`,
    baseDelayMs: 1000,
    maxDelayMs: 15000,
  })))
}

function normalizeList(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Find a Tebra patient matching by MRN (Tebra "PatientID"/chart number) or
 * name + date of birth, or create one if no match exists.
 * @returns {Promise<string>} the Tebra patient id
 */
async function findOrCreatePatient(patient, credentials) {
  const searchResult = await callTebra(OPS.getPatients, {
    ...requestHeader(credentials),
    Filter: {
      PracticeID: credentials.practiceId,
      ChartNumber: patient.mrn,
    },
  }, `Tebra findPatient (mrn=${patient.mrn})`)

  const matches = normalizeList(searchResult?.GetPatientsResult?.Patients?.PatientData)
  const existing = matches.find((p) => String(p?.ChartNumber || '').toUpperCase() === String(patient.mrn).toUpperCase())
  if (existing?.PatientID) return String(existing.PatientID)

  const created = await callTebra(OPS.createPatient, {
    ...requestHeader(credentials),
    Patient: {
      PracticeID: credentials.practiceId,
      ChartNumber: patient.mrn,
      FirstName: patient.first_name || patient.name,
      LastName: patient.last_name || '',
      DateofBirth: patient.date_of_birth || undefined,
    },
  }, `Tebra createPatient (mrn=${patient.mrn})`)

  const newId = created?.CreatePatientResult?.PatientID
  if (!newId) throw new Error('Tebra createPatient did not return a PatientID')
  return String(newId)
}

/**
 * Push a finalized clinical note into Tebra as an encounter.
 * @returns {Promise<string>} the Tebra encounter id
 */
async function pushEncounterNote({ note, visit, tebraPatientId, credentials }) {
  const result = await callTebra(OPS.createEncounter, {
    ...requestHeader(credentials),
    Encounter: {
      PracticeID: credentials.practiceId,
      PatientID: tebraPatientId,
      ServiceDate: visit.visit_date,
      ProviderID: visit.tebra_provider_id || undefined,
      Note: note.final_note,
    },
  }, `Tebra pushEncounterNote (visit=${visit.id})`)

  const encounterId = result?.CreateEncounterResult?.EncounterID
  if (!encounterId) throw new Error('Tebra createEncounter did not return an EncounterID')
  return String(encounterId)
}

/** Pull appointments for a provider within a date range. */
async function pullAppointments({ providerId, dateFrom, dateTo }, credentials) {
  const result = await callTebra(OPS.getAppointments, {
    ...requestHeader(credentials),
    Filter: {
      PracticeID: credentials.practiceId,
      ProviderID: providerId,
      StartDate: dateFrom,
      EndDate: dateTo,
    },
  }, `Tebra pullAppointments (provider=${providerId})`)

  return normalizeList(result?.GetAppointmentsResult?.Appointments?.AppointmentData)
}

/** Pull patients updated since a given timestamp (for the periodic sync job). */
async function pullPatients({ updatedSince } = {}, credentials) {
  const result = await callTebra(OPS.getPatients, {
    ...requestHeader(credentials),
    Filter: {
      PracticeID: credentials.practiceId,
      LastModifiedStartDate: updatedSince || undefined,
    },
  }, 'Tebra pullPatients')

  return normalizeList(result?.GetPatientsResult?.Patients?.PatientData)
}

/** Cheap connectivity check for the settings "test" button. */
async function testConnection(credentials) {
  await callTebra(OPS.getProviders, {
    ...requestHeader(credentials),
    Filter: { PracticeID: credentials.practiceId },
  }, 'Tebra testConnection')
  return true
}

module.exports = {
  resolveTebraCredentials,
  findOrCreatePatient,
  pushEncounterNote,
  pullAppointments,
  pullPatients,
  testConnection,
  getTebraCircuitStatus,
  OPS,
  /** exposed for tests only */
  _internal: { getTebraClient, callTebra, requestHeader, normalizeList },
}
