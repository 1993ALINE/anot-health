// Production API URL — set in .env.production and CI (required for `npm run build`).
import { getCurrentUser as readStoredUser } from '../utils/getCurrentUser'
import { fetchCsrfToken, getCsrfToken, getCsrfHeaders, clearCsrfToken } from '../utils/csrf'
import {
  getToken,
  setSession,
  clearSession,
  setStoredUser,
  clearAppCaches,
  purgeExpiredSession,
  hasValidSession,
} from '../utils/sessionAuth'

purgeExpiredSession()

const envApiUrl = import.meta.env.VITE_API_URL?.replace(/\/+$/, '') || ''

// Opening a *production* build on localhost (e.g. `vite preview`) still injects
// VITE_API_URL from `.env.production`, which often points at an old API that requires
// `role` on login. Prefer the local API whenever the page is served from this machine.
const isBrowserLocal =
  typeof globalThis !== 'undefined' &&
  typeof globalThis.location !== 'undefined' &&
  (globalThis.location.hostname === 'localhost' ||
    globalThis.location.hostname === '127.0.0.1')

const forceRemoteApi =
  import.meta.env.VITE_USE_LOCAL_API === 'false' ||
  import.meta.env.VITE_USE_LOCAL_API === '0'

// Use 127.0.0.1 (not "localhost") so Windows browsers don’t hit IPv6 ::1 while Node listens on IPv4 — avoids "Failed to fetch".
const LOCAL_API_BASE = 'http://127.0.0.1:5000/api'

export const API_BASE = (() => {
  if (isBrowserLocal && !forceRemoteApi) {
    return LOCAL_API_BASE
  }
  if (envApiUrl) {return envApiUrl}
  if (import.meta.env.DEV) {return LOCAL_API_BASE}
  // Production build without VITE_API_URL — vite.config.js should block the build.
  console.error('[api] VITE_API_URL is not set; API calls will fail.')
  return '/api'
})()

/** True when a request was cancelled via AbortController (stale/superseded load). */
export function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 20)
}

/** True when `fetch` did not get a normal HTTP response (backend down, DNS, CORS, blocked port, etc.). */
export function isLikelyNetworkFailure(err) {
  if (!err) {return false}
  if (err.name === 'TypeError') {return true}
  if (err.name === 'AbortError') {return true}
  const m = String(err.message || '').toLowerCase()
  return (
    m === 'failed to fetch' ||
    m.includes('failed to fetch') ||
    m.includes('networkerror') ||
    m.includes('load failed') ||
    m.includes('network request failed')
  )
}

const BASE_URL = API_BASE

/**
 * @deprecated Token is HttpOnly cookie — use hasValidSession() instead.
 */
const getAuthToken = () => getToken()
/**
 * Build request headers for API calls.
 * Session JWT is sent via HttpOnly cookie (credentials: include).
 * Bearer Authorization is only added when explicitly passed in extraHeaders (login gates).
 */
function buildRequestHeaders(includeAuth = true, extraHeaders = {}) {
  const h = { 'Content-Type': 'application/json', ...extraHeaders }
  return h
}

/** @deprecated Use buildRequestHeaders — kept for existing call sites. */
const headers = buildRequestHeaders

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const API_CSRF_DEBUG =
  import.meta.env.DEV ||
  import.meta.env.VITE_CSRF_DEBUG === 'true' ||
  import.meta.env.VITE_CSRF_DEBUG === '1'

/** Headers for mutating requests: Bearer auth + CSRF token (cookie double-submit). */
async function buildApiHeaders(method, includeAuth = true, extraHeaders = {}, { forceRefresh = false } = {}) {
  const h = buildRequestHeaders(includeAuth, extraHeaders)
  const upper = String(method).toUpperCase()
  if (MUTATING_METHODS.has(upper)) {
    await fetchCsrfToken(API_BASE, { forceRefresh })
    const csrf = getCsrfToken()
    Object.assign(h, getCsrfHeaders(csrf))
  }
  return h
}

function isCsrfError(data) {
  return String(data?.error || '').toLowerCase().includes('csrf')
}

/**
 * Unified fetch wrapper for ALL API requests (GET, POST, PUT, DELETE).
 * Always sends credentials: 'include' and X-CSRF-Token header.
 */
export async function apiFetch(path, {
  method = 'GET',
  body,
  includeAuth = true,
  extraHeaders = {},
  signal,
  responseType = 'json',
} = {}) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
  const upper = String(method).toUpperCase()
  const isFormData = body instanceof FormData

  const run = async (forceRefresh) => {
    const hdrs = await buildApiHeaders(upper, includeAuth, extraHeaders, { forceRefresh })
    if (MUTATING_METHODS.has(upper)) {
      const token = hdrs['X-CSRF-Token']
      if (API_CSRF_DEBUG) {
        console.warn('[API] Mutating method:', upper)
        console.warn('[API] CSRF token:', token)
        console.warn('[API] Cookies:', typeof document !== 'undefined' ? document.cookie : '(n/a)')
      }
    }
    if (isFormData) { delete hdrs['Content-Type'] }
    const opts = { method: upper, credentials: 'include', headers: hdrs }
    if (body !== null && body !== undefined && upper !== 'GET' && upper !== 'HEAD') {
      opts.body = isFormData || typeof body === 'string' ? body : JSON.stringify(body)
    }
    if (signal) { opts.signal = signal }
    return fetch(url, opts)
  }

  let res = await run(false)
  if (res.status === 403 && MUTATING_METHODS.has(upper)) {
    const peek = parseResponseBody(await res.clone().text(), res)
    if (isCsrfError(peek)) {
      clearCsrfToken()
      res = await run(true)
    }
  }

  if (responseType === 'blob') {
    if (!res.ok) {
      const errData = parseResponseBody(await res.text(), res)
      throw createApiError(errData, res)
    }
    return res.blob()
  }
  if (responseType === 'raw') { return res }
  return handleResponse(res)
}

/**
 * JSON (or FormData) mutating request — delegates to apiFetch.
 */
async function apiMutate(method, path, { body, includeAuth = true, extraHeaders = {}, signal } = {}) {
  return apiFetch(path, { method, body, includeAuth, extraHeaders, signal })
}

/**
 * Parse response body text as JSON with fallback error payload.
 */
function parseResponseBody(text, res) {
  if (!text) {return {}}
  try {
    return JSON.parse(text)
  } catch {
    return { error: res.ok ? 'Invalid response from server.' : (text.slice(0, 200) || 'Request failed') }
  }
}

const CLIENT_STATUS_MESSAGES = {
  400: 'Invalid request',
  401: 'Authentication failed',
  403: 'Access denied',
  404: 'Resource not found',
  429: 'Too many requests',
  500: 'Something went wrong',
  503: 'Service temporarily unavailable',
}

function sanitizeClientError(data, res) {
  if (import.meta.env.PROD) {
    return CLIENT_STATUS_MESSAGES[res.status] || CLIENT_STATUS_MESSAGES[500]
  }
  return data.error || CLIENT_STATUS_MESSAGES[res.status] || `Request failed (${res.status})`
}

/**
 * Build an Error from a failed API response.
 */
function createApiError(data, res) {
  const err = new Error(sanitizeClientError(data, res))
  err.status = res.status
  err.payload = data
  return err
}

/**
 * Handle fetch response — parse body and throw on non-OK status.
 */
const handleResponse = async (res) => {
  const text = await res.text()
  const data = parseResponseBody(text, res)
  if (!res.ok) {throw createApiError(data, res)}
  return data
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

export const authAPI = {
  login: async (email, password) => {
    const data = await apiMutate('POST', '/auth/login', {
      includeAuth: false,
      body: { email, password },
    })
    // Persist session when login completes (HttpOnly cookie set by server).
    if (data.user && !data.temporaryToken && !data.requireMfa && !data.requirePhiTraining && !data.requirePasswordChange) {
      setSession(data.user)
    }
    return data
  },
  /**
   * Completes the PHI-training gate. Exchanges the short-lived temporaryToken
   * from login for a real session token, then persists the session.
   */
  acknowledgePhiTraining: async (temporaryToken) => {
    const data = await apiMutate('POST', '/auth/acknowledge-phi-training', {
      includeAuth: false,
      body: { temporaryToken },
    })
    // Only persist a full session when no further login gates remain.
    if (data.user && !data.enrollmentRequired && !data.requireMfa && !data.temporaryToken) {
      setSession(data.user)
    }
    return data
  },
  verifyMfaLogin: async (temporaryToken, token, recoveryCode) => {
    const data = await apiMutate('POST', '/auth/verify-mfa', {
      includeAuth: false,
      body: { temporaryToken, token, recoveryCode },
    })
    if (data.user) {
      setSession(data.user)
    }
    return data
  },
  logout: async () => {
    try {
      await apiMutate('POST', '/auth/logout')
    } catch {
      /* ignore — clear local state regardless */
    }
    clearSession()
    clearCsrfToken()
    await clearAppCaches()
  },
  getCurrentUser: () => {
    const user = readStoredUser()
    return Object.keys(user).length ? user : null
  },
  isLoggedIn: () => hasValidSession(),
  /** Validates the session and refreshes cached user from the server. */
  getMe: async () => {
    const data = await apiFetch('/auth/me')
    if (data.user) {
      setSession(data.user)
    }
    return data
  },
  updateMe: async ({ name, email, phone, avatar_data_url, personal_info }) => {
    const data = await apiMutate('PUT', '/auth/me', {
      body: { name, email, phone, avatar_data_url, personal_info },
    })
    if (data.user) { setStoredUser(data.user) }
    return data
  },
  changePassword: async (currentPassword, newPassword) => {
    return apiMutate('PUT', '/auth/change-password', {
      body: { currentPassword, newPassword },
    })
  },
  /**
   * Forced first-login password change. The short-lived temporaryToken from a
   * `requirePasswordChange` login is sent as the Bearer credential (it is scoped
   * server-side to this endpoint only); no current password is required. The
   * endpoint returns no session — the caller should re-authenticate with the new
   * password to continue any remaining gates (e.g. PHI training).
   */
  changePasswordWithToken: async (temporaryToken, newPassword) => {
    return apiMutate('PUT', '/auth/change-password', {
      includeAuth: false,
      extraHeaders: { Authorization: `Bearer ${temporaryToken}` },
      body: { newPassword },
    })
  },
}

export const mfaAPI = {
  setupWithToken: async (temporaryToken) =>
    apiMutate('POST', '/mfa/setup', {
      includeAuth: false,
      extraHeaders: { Authorization: `Bearer ${temporaryToken}` },
    }),
  verifyWithToken: async (temporaryToken, token) => {
    const data = await apiMutate('POST', '/mfa/verify', {
      includeAuth: false,
      extraHeaders: { Authorization: `Bearer ${temporaryToken}` },
      body: { token },
    })
    if (data.user) {
      setSession(data.user)
    }
    return data
  },
}

// ─── USERS ────────────────────────────────────────────────────────────────────

export const usersAPI = {
  getAll: async () => apiFetch('/users'),
  register: async (userData) => apiMutate('POST', '/auth/register', { body: userData }),
  update: async (id, userData) => apiMutate('PUT', `/users/${id}`, { body: userData }),
  /** Super Admin: update only `admin_modules` (faster than full PUT /users/:id). */
  patchAdminModules: async (id, admin_modules) => apiMutate('PATCH', `/users/${id}/admin-modules`, { body: { admin_modules } }),
  toggleStatus: async (id) => apiMutate('PUT', `/users/${id}/toggle-status`),
  deleteUser: async (id) => apiMutate('DELETE', `/users/${id}`),
  getByRole: async (role) => apiFetch(`/users/role/${role}`),
  getMyClinicians: async () => apiFetch('/assignments/my-clinicians'),
  // The server generates the temporary password and returns it once; the client
  // no longer supplies one.
  resetPassword: async (id) => apiMutate('PUT', `/users/${id}/reset-password`),
  updateRate: async (id, rate) => apiMutate('PUT', `/users/${id}/rate`, { body: { rate_per_note: rate } }),
}

// ─── PATIENTS ─────────────────────────────────────────────────────────────────

export const patientsAPI = {
  getAll: async () => apiFetch('/patients'),
  create: async (patientData) => apiMutate('POST', '/patients', { body: patientData }),
}

// ─── VISITS ───────────────────────────────────────────────────────────────────

export const visitsAPI = {
  getByDate: async (date, signal) => apiFetch(`/visits/my?date=${encodeURIComponent(date)}`, { signal }),
  getHistory: async (signal) => apiFetch('/visits/history', { signal }),
  getAll: async (providerId, date, signal) => {
    const params = new URLSearchParams()
    if (providerId) {params.append('provider_id', providerId)}
    if (date)       {params.append('date', date)}
    return apiFetch(`/visits?${params.toString()}`, { signal })
  },
  create: async (visitData) => apiMutate('POST', '/visits', { body: visitData }),
  updateStatus: async (id, status) => apiMutate('PUT', `/visits/${id}/status`, { body: { status } }),
  endVisit: async (id, durationSeconds) => apiMutate('PUT', `/visits/${id}/end`, { body: { duration_seconds: durationSeconds } }),
  updateVisit: async (id, data) => apiMutate('PUT', `/visits/${id}`, { body: data }),
  deleteVisit: async (id) => apiMutate('DELETE', `/visits/${id}`),
  lockNote: async (id) => apiMutate('POST', `/visits/${id}/lock-note`),
  uploadAudio: async (visitId, audioBlob) => {
    const formData = new FormData()
    const ext = audioBlob.type?.includes('mp4') ? 'mp4' : audioBlob.type?.includes('ogg') ? 'ogg' : 'webm'
    formData.append('audio', audioBlob, `visit_${visitId}_${Date.now()}.${ext}`)
    return apiMutate('POST', `/audio/${visitId}`, { body: formData })
  },
  appendAudio: async (visitId, audioBlob) => {
    const formData = new FormData()
    const ext = audioBlob.type?.includes('mp4') ? 'mp4' : audioBlob.type?.includes('ogg') ? 'ogg' : 'webm'
    formData.append('audio', audioBlob, `visit_${visitId}_extra_${Date.now()}.${ext}`)
    return apiMutate('POST', `/audio/${visitId}/append`, { body: formData })
  },
  uploadAudioFile: async (visitId, file) => {
    const formData = new FormData()
    formData.append('audio', file, file.name)
    return apiMutate('POST', `/audio/${visitId}`, { body: formData })
  },
  /** Queue server-side transcription + AI draft (HTTP 202). */
  runTranscription: async (visitId) => apiMutate('POST', `/visits/${visitId}/transcribe`),
  /** Regenerate AI draft from saved transcriptions (HTTP 200). */
  generateDraft: async (visitId) => apiMutate('POST', `/visits/${visitId}/generate-draft`),
}

// ─── NOTES ────────────────────────────────────────────────────────────────────

export const notesAPI = {
  getByVisit: async (visitId, signal) => apiFetch(`/notes/visit/${visitId}`, { signal }),
  getMyNotes: async () => apiFetch('/notes/my'),
  getClinicianNotes: async () => apiFetch('/notes/clinician'),
  getAllNotes: async (providerId, status) => {
    const params = new URLSearchParams()
    if (providerId) {params.append('provider_id', providerId)}
    if (status)     {params.append('status', status)}
    return apiFetch(`/notes?${params.toString()}`)
  },
  saveDraft: async (visitId, finalNote, transcription, aiDraft) => apiMutate('POST', '/notes/draft', {
    body: {
      visit_id:      visitId,
      final_note:    finalNote,
      transcription: transcription || null,
      ai_draft:      aiDraft || null,
    },
  }),
  submitNote: async (noteId) => apiMutate('PUT', `/notes/${noteId}/submit`),
  updateNote: async (noteId, finalNote) => apiMutate('PUT', `/notes/${noteId}`, { body: { final_note: finalNote } }),
  requestEdit: async (noteId, message) => apiMutate('PUT', `/notes/${noteId}/request-edit`, { body: { message } }),
  uploadToEHR: async (noteId) => apiMutate('POST', `/notes/${noteId}/upload-ehr`),
  submitGrade: async (gradeData) => apiMutate('POST', '/notes/grade', { body: gradeData }),
  getMyGrades: async () => apiFetch('/notes/my-grades'),
}

// ─── ADMIN ────────────────────────────────────────────────────────────────────

export const adminAPI = {
  getStats: async () => apiFetch('/users/stats'),
  getPayroll: async () => apiFetch('/users/payroll'),
  getPerformance: async () => apiFetch('/users/performance'),
  getAuditLogs: async (params = {}) => {
    const query = new URLSearchParams(params).toString()
    return apiFetch(`/audit?${query}`)
  },
  getAuditSummary: async (params = {}) => {
    const query = new URLSearchParams(params).toString()
    return apiFetch(`/audit/summary?${query}`)
  },
  exportAuditLogs: async (format, params = {}) => {
    const q = new URLSearchParams({ ...params, format }).toString()
    return apiFetch(`/audit/export?${q}`, { responseType: 'blob' })
  },
  applyAuditRetention: async () => apiMutate('POST', '/audit/retention/apply'),
  getSystemHealth: async () => apiFetch('/admin/health'),
  generateAI: async (visitId) => apiMutate('POST', `/visits/${visitId}/generate-ai`),
}

export const settingsAPI = {
  getPublic: async () => apiFetch('/settings/public', { includeAuth: false }),
  getInternal: async () => apiFetch('/settings/internal'),
  getTranscription: async () => apiFetch('/settings/transcription'),
  updateTranscription: async (settings) => apiMutate('PUT', '/settings/transcription', { body: { settings } }),
  update: async (settings) => apiMutate('PUT', '/settings', { body: settings }),
  getClinicianTemplates: async () => apiFetch('/settings/clinician-templates'),
  saveClinicianTemplates: async (templates) =>
    apiMutate('POST', '/settings/clinician-templates', { body: { templates } }),
  deleteClinicianTemplate: async (id) => apiMutate('DELETE', `/settings/clinician-templates/${encodeURIComponent(id)}`),
}

export const assignmentsAPI = {
  getAll: async () => apiFetch('/assignments'),
  create: async (clinicianId, scribeId) => apiMutate('POST', '/assignments', {
    body: { clinician_id: clinicianId, scribe_id: scribeId },
  }),
  delete: async (id) => apiMutate('DELETE', `/assignments/${id}`),
}

export const supportAPI = {
  sendMessage: async (payload) => apiMutate('POST', '/support/message', { body: payload }),
}

export const consentAPI = {
  recordRecording: async (visitId) =>
    apiMutate('POST', '/consent/recording', { body: { visitId } }),
}

export const audioAPI = {
  getCount: async (visitId) => apiFetch(`/audio/${visitId}/count`),
  getBlob: async (visitId, index = 0) =>
    apiFetch(`/audio/${visitId}?index=${index}`, { responseType: 'blob' }),
}