'use strict'

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createCookieJar() {
  const cookies = new Map()
  return {
    store(res) {
      const raw = res.headers.getSetCookie?.() || []
      for (const line of raw) {
        const part = line.split(';')[0]
        const eq = part.indexOf('=')
        if (eq > 0) cookies.set(part.slice(0, eq), part.slice(eq + 1))
      }
    },
    headers() {
      if (cookies.size === 0) return {}
      return { Cookie: [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
    },
  }
}

async function fetchCsrfToken(apiBase, cookieJar) {
  const res = await fetch(`${apiBase}/csrf-token`, {
    credentials: 'include',
    headers: cookieJar.headers(),
  })
  if (!res.ok) throw new Error(`CSRF fetch failed: ${res.status}`)
  const data = await res.json()
  cookieJar.store(res)
  return data.csrfToken
}

async function apiLogin(apiBase, email, password, cookieJar) {
  const csrf = await fetchCsrfToken(apiBase, cookieJar)
  const res = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      ...cookieJar.headers(),
    },
    body: JSON.stringify({ email, password }),
  })
  cookieJar.store(res)
  const data = await res.json()
  if (!res.ok || !data.token) {
    throw new Error(data.error || `Login failed (${res.status})`)
  }
  await fetchCsrfToken(apiBase, cookieJar)
  return { token: data.token, user: data.user }
}

async function apiFetch(apiBase, path, { token, jar } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...jar.headers() },
  })
  jar.store(res)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`)
    err.status = res.status
    err.payload = data
    throw err
  }
  return data
}

async function apiMutate(apiBase, method, path, { token, jar, csrf, body } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...jar.headers(),
  }
  let payload
  if (body instanceof FormData) {
    payload = body
  } else {
    headers['Content-Type'] = 'application/json'
    headers['X-CSRF-Token'] = csrf || (await fetchCsrfToken(apiBase, jar))
    payload = JSON.stringify(body || {})
  }
  const res = await fetch(`${apiBase}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: payload,
  })
  jar.store(res)
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`)
    err.status = res.status
    err.payload = data
    throw err
  }
  return data
}

module.exports = {
  sleep,
  createCookieJar,
  fetchCsrfToken,
  apiLogin,
  apiFetch,
  apiMutate,
}
