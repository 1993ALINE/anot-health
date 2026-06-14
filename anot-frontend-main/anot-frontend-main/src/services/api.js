// Railway fallback when the app is deployed (hostname is not localhost).
import { getCurrentUser as readStoredUser } from '../utils/getCurrentUser'

const DEFAULT_PROD_API = 'https://anot-backend-production.up.railway.app/api'

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
  if (envApiUrl) return envApiUrl
  if (import.meta.env.DEV) return LOCAL_API_BASE
  return DEFAULT_PROD_API
})()

/** True when a request was cancelled via AbortController (stale/superseded load). */
export function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 20)
}

/** True when `fetch` did not get a normal HTTP response (backend down, DNS, CORS, blocked port, etc.). */
export function isLikelyNetworkFailure(err) {
  if (!err) return false
  if (err.name === 'TypeError') return true
  if (err.name === 'AbortError') return true
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

const getToken = () => localStorage.getItem('token')

const headers = (includeAuth = true) => {
  const h = { 'Content-Type': 'application/json' }
  if (includeAuth) {
    const token = getToken()
    if (token) h['Authorization'] = `Bearer ${token}`
  }
  return h
}

const handleResponse = async (res) => {
  const text = await res.text()
  let data = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: res.ok ? 'Invalid response from server.' : (text.slice(0, 200) || 'Request failed') }
    }
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`)
    err.status = res.status
    err.payload = data
    throw err
  }
  return data
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

export const authAPI = {
  login: async (email, password) => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: headers(false),
      body: JSON.stringify({ email, password }),
    })
    const data = await handleResponse(res)
    // Only persist a session when the server issued a real token. Gated logins
    // (e.g. requirePhiTraining / requirePasswordChange) return a temporaryToken
    // instead — the caller drives the follow-up step before a session exists.
    if (data.token && data.user) {
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(data.user))
    }
    return data
  },
  /**
   * Completes the PHI-training gate. Exchanges the short-lived temporaryToken
   * from login for a real session token, then persists the session.
   */
  acknowledgePhiTraining: async (temporaryToken) => {
    const res = await fetch(`${BASE_URL}/auth/acknowledge-phi-training`, {
      method: 'POST',
      headers: headers(false),
      body: JSON.stringify({ temporaryToken }),
    })
    const data = await handleResponse(res)
    if (data.token && data.user) {
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(data.user))
    }
    return data
  },
  logout: async () => {
    const t = getToken()
    // Clear local session state FIRST. If the server call were awaited before
    // clearing, navigating to /login would still see a token, fire getMe, and
    // bounce the user back into their portal right after they clicked Log out.
    const authHeaders = headers()
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    if (t) {
      try {
        await fetch(`${BASE_URL}/auth/logout`, { method: 'POST', headers: authHeaders })
      } catch {
        /* ignore — local session already cleared */
      }
    }
  },
  getCurrentUser: () => {
    const user = readStoredUser()
    return Object.keys(user).length ? user : null
  },
  isLoggedIn: () => !!getToken(),
  /** Validates the session and refreshes cached user from the server. */
  getMe: async () => {
    const res = await fetch(`${BASE_URL}/auth/me`, { headers: headers() })
    const data = await handleResponse(res)
    // Don't re-persist the user if a logout cleared the session while this
    // request was in flight — that would leave PHI-adjacent profile data in
    // localStorage on a shared workstation after sign-out.
    if (data.user && getToken()) localStorage.setItem('user', JSON.stringify(data.user))
    return data
  },
  updateMe: async ({ name, email, phone, avatar_data_url, personal_info }) => {
    const res = await fetch(`${BASE_URL}/auth/me`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ name, email, phone, avatar_data_url, personal_info }),
    })
    const data = await handleResponse(res)
    if (data.user) localStorage.setItem('user', JSON.stringify(data.user))
    return data
  },
  changePassword: async (currentPassword, newPassword) => {
    const res = await fetch(`${BASE_URL}/auth/change-password`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    return handleResponse(res)
  },
  /**
   * Forced first-login password change. The short-lived temporaryToken from a
   * `requirePasswordChange` login is sent as the Bearer credential (it is scoped
   * server-side to this endpoint only); no current password is required. The
   * endpoint returns no session — the caller should re-authenticate with the new
   * password to continue any remaining gates (e.g. PHI training).
   */
  changePasswordWithToken: async (temporaryToken, newPassword) => {
    const res = await fetch(`${BASE_URL}/auth/change-password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${temporaryToken}` },
      body: JSON.stringify({ newPassword }),
    })
    return handleResponse(res)
  },
}

// ─── USERS ────────────────────────────────────────────────────────────────────

export const usersAPI = {
  getAll: async () => {
    const res = await fetch(`${BASE_URL}/users`, { headers: headers() })
    return handleResponse(res)
  },
  register: async (userData) => {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(userData),
    })
    return handleResponse(res)
  },
  update: async (id, userData) => {
    const res = await fetch(`${BASE_URL}/users/${id}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(userData),
    })
    return handleResponse(res)
  },
  /** Super Admin: update only `admin_modules` (faster than full PUT /users/:id). */
  patchAdminModules: async (id, admin_modules) => {
    const res = await fetch(`${BASE_URL}/users/${id}/admin-modules`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ admin_modules }),
    })
    return handleResponse(res)
  },
  toggleStatus: async (id) => {
    const res = await fetch(`${BASE_URL}/users/${id}/toggle-status`, {
      method: 'PUT',
      headers: headers(),
    })
    return handleResponse(res)
  },
  deleteUser: async (id) => {
    const res = await fetch(`${BASE_URL}/users/${id}`, {
      method: 'DELETE',
      headers: headers(),
    })
    return handleResponse(res)
  },
  getByRole: async (role) => {
    const res = await fetch(`${BASE_URL}/users/role/${role}`, { headers: headers() })
    return handleResponse(res)
  },
  getMyClinicians: async () => {
    const res = await fetch(`${BASE_URL}/assignments/my-clinicians`, { headers: headers() })
    return handleResponse(res)
  },
  resetPassword: async (id, password) => {
    const res = await fetch(`${BASE_URL}/users/${id}/reset-password`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ password }),
    })
    return handleResponse(res)
  },
  updateRate: async (id, rate) => {
    const res = await fetch(`${BASE_URL}/users/${id}/rate`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ rate_per_note: rate }),
    })
    return handleResponse(res)
  },
}

// ─── PATIENTS ─────────────────────────────────────────────────────────────────

export const patientsAPI = {
  getAll: async () => {
    const res = await fetch(`${BASE_URL}/patients`, { headers: headers() })
    return handleResponse(res)
  },
  create: async (patientData) => {
    const res = await fetch(`${BASE_URL}/patients`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(patientData),
    })
    return handleResponse(res)
  },
}

// ─── VISITS ───────────────────────────────────────────────────────────────────

export const visitsAPI = {
  getByDate: async (date, signal) => {
    const res = await fetch(`${BASE_URL}/visits/my?date=${encodeURIComponent(date)}`, { headers: headers(), signal })
    return handleResponse(res)
  },
  getHistory: async (signal) => {
    const res = await fetch(`${BASE_URL}/visits/history`, { headers: headers(), signal })
    return handleResponse(res)
  },
  getAll: async (providerId, date, signal) => {
    const params = new URLSearchParams()
    if (providerId) params.append('provider_id', providerId)
    if (date)       params.append('date', date)
    const res = await fetch(`${BASE_URL}/visits?${params.toString()}`, { headers: headers(), signal })
    return handleResponse(res)
  },
  create: async (visitData) => {
    const res = await fetch(`${BASE_URL}/visits`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(visitData),
    })
    return handleResponse(res)
  },
  updateStatus: async (id, status) => {
    const res = await fetch(`${BASE_URL}/visits/${id}/status`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ status }),
    })
    return handleResponse(res)
  },
  endVisit: async (id, durationSeconds) => {
    const res = await fetch(`${BASE_URL}/visits/${id}/end`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ duration_seconds: durationSeconds }),
    })
    return handleResponse(res)
  },
  updateVisit: async (id, data) => {
    const res = await fetch(`${BASE_URL}/visits/${id}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(data),
    })
    return handleResponse(res)
  },
  deleteVisit: async (id) => {
    const res = await fetch(`${BASE_URL}/visits/${id}`, {
      method: 'DELETE',
      headers: headers(),
    })
    return handleResponse(res)
  },
  lockNote: async (id) => {
    const res = await fetch(`${BASE_URL}/visits/${id}/lock-note`, {
      method: 'POST',
      headers: headers(),
    })
    return handleResponse(res)
  },
  uploadAudio: async (visitId, audioBlob) => {
    const formData = new FormData()
    const ext = audioBlob.type?.includes('mp4') ? 'mp4' : audioBlob.type?.includes('ogg') ? 'ogg' : 'webm'
    formData.append('audio', audioBlob, `visit_${visitId}_${Date.now()}.${ext}`)
    const res = await fetch(`${BASE_URL}/audio/${visitId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
    })
    return handleResponse(res)
  },
  appendAudio: async (visitId, audioBlob) => {
    const formData = new FormData()
    const ext = audioBlob.type?.includes('mp4') ? 'mp4' : audioBlob.type?.includes('ogg') ? 'ogg' : 'webm'
    formData.append('audio', audioBlob, `visit_${visitId}_extra_${Date.now()}.${ext}`)
    const res = await fetch(`${BASE_URL}/audio/${visitId}/append`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
    })
    return handleResponse(res)
  },
  uploadAudioFile: async (visitId, file) => {
    const formData = new FormData()
    formData.append('audio', file, file.name)
    const res = await fetch(`${BASE_URL}/audio/${visitId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
    })
    return handleResponse(res)
  },
  /** Queue server-side transcription + AI draft (HTTP 202). */
  runTranscription: async (visitId) => {
    const res = await fetch(`${BASE_URL}/visits/${visitId}/transcribe`, {
      method: 'POST',
      headers: headers(),
    })
    return handleResponse(res)
  },
  /** Regenerate AI draft from saved transcriptions (HTTP 200). */
  generateDraft: async (visitId) => {
    const res = await fetch(`${BASE_URL}/visits/${visitId}/generate-draft`, {
      method: 'POST',
      headers: headers(),
    })
    return handleResponse(res)
  },
}

// ─── NOTES ────────────────────────────────────────────────────────────────────

export const notesAPI = {
  getByVisit: async (visitId, signal) => {
    const res = await fetch(`${BASE_URL}/notes/visit/${visitId}`, { headers: headers(), signal })
    return handleResponse(res)
  },
  getMyNotes: async () => {
    const res = await fetch(`${BASE_URL}/notes/my`, { headers: headers() })
    return handleResponse(res)
  },
  getClinicianNotes: async () => {
    const res = await fetch(`${BASE_URL}/notes/clinician`, { headers: headers() })
    return handleResponse(res)
  },
  getAllNotes: async (providerId, status) => {
    const params = new URLSearchParams()
    if (providerId) params.append('provider_id', providerId)
    if (status)     params.append('status', status)
    const res = await fetch(`${BASE_URL}/notes?${params.toString()}`, { headers: headers() })
    return handleResponse(res)
  },
  saveDraft: async (visitId, finalNote, transcription, aiDraft) => {
    const res = await fetch(`${BASE_URL}/notes/draft`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        visit_id:      visitId,
        final_note:    finalNote,
        transcription: transcription || null,
        ai_draft:      aiDraft || null,
      }),
    })
    return handleResponse(res)
  },
  submitNote: async (noteId) => {
    const res = await fetch(`${BASE_URL}/notes/${noteId}/submit`, {
      method: 'PUT',
      headers: headers(),
    })
    return handleResponse(res)
  },
  updateNote: async (noteId, finalNote) => {
    const res = await fetch(`${BASE_URL}/notes/${noteId}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ final_note: finalNote }),
    })
    return handleResponse(res)
  },
  requestEdit: async (noteId, message) => {
    const res = await fetch(`${BASE_URL}/notes/${noteId}/request-edit`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ message }),
    })
    return handleResponse(res)
  },
  uploadToEHR: async (noteId) => {
    const res = await fetch(`${BASE_URL}/notes/${noteId}/upload-ehr`, {
      method: 'POST',
      headers: headers(),
    })
    return handleResponse(res)
  },
  submitGrade: async (gradeData) => {
    const res = await fetch(`${BASE_URL}/notes/grade`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(gradeData),
    })
    return handleResponse(res)
  },
  getMyGrades: async () => {
    const res = await fetch(`${BASE_URL}/notes/my-grades`, { headers: headers() })
    return handleResponse(res)
  },
}

// ─── ADMIN ────────────────────────────────────────────────────────────────────

export const adminAPI = {
  getStats: async () => {
    const res = await fetch(`${BASE_URL}/users/stats`, { headers: headers() })
    return handleResponse(res)
  },
  getPayroll: async () => {
    const res = await fetch(`${BASE_URL}/users/payroll`, { headers: headers() })
    return handleResponse(res)
  },
  getPerformance: async () => {
    const res = await fetch(`${BASE_URL}/users/performance`, { headers: headers() })
    return handleResponse(res)
  },
  getAuditLogs: async (params = {}) => {
    const query = new URLSearchParams(params).toString()
    const res = await fetch(`${BASE_URL}/audit?${query}`, { headers: headers() })
    return handleResponse(res)
  },
  getAuditSummary: async (params = {}) => {
    const query = new URLSearchParams(params).toString()
    const res = await fetch(`${BASE_URL}/audit/summary?${query}`, { headers: headers() })
    return handleResponse(res)
  },
  exportAuditLogs: async (format, params = {}) => {
    const q = new URLSearchParams({ ...params, format }).toString()
    const res = await fetch(`${BASE_URL}/audit/export?${q}`, { headers: headers() })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Export failed')
    }
    return res.blob()
  },
  applyAuditRetention: async () => {
    const res = await fetch(`${BASE_URL}/audit/retention/apply`, { method: 'POST', headers: headers() })
    return handleResponse(res)
  },
  generateAI: async (visitId) => {
    const res = await fetch(`${BASE_URL}/visits/${visitId}/generate-ai`, {
      method: 'POST',
      headers: headers(),
    })
    return handleResponse(res)
  },
}

export const settingsAPI = {
  getPublic: async () => {
    const res = await fetch(`${BASE_URL}/settings/public`, { headers: headers(false) })
    return handleResponse(res)
  },
  getInternal: async () => {
    const res = await fetch(`${BASE_URL}/settings/internal`, { headers: headers() })
    return handleResponse(res)
  },
  update: async (settings) => {
    const res = await fetch(`${BASE_URL}/settings`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(settings),
    })
    return handleResponse(res)
  },
}