/** Audio / timer display: always MM:SS */
export function fmtSecsAudio(s) {
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return '00:00'
  const m = Math.floor(n / 60)
  const sec = Math.floor(n % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export function fmtDurationShort(secs) {
  if (!secs) return '—'
  return fmtSecsAudio(secs)
}

/** Appointment time from DB (HH:mm or HH:mm:ss) */
export function fmtAppointmentTime(t) {
  if (!t) return ''
  const raw = String(t).trim()
  if (/^\d{1,2}:\d{2}/.test(raw)) {
    const [h, m] = raw.split(':')
    const hour = parseInt(h, 10)
    if (Number.isNaN(hour)) return raw
    const min = m?.slice(0, 2) || '00'
    const h12 = hour % 12 || 12
    const ampm = hour >= 12 ? 'PM' : 'AM'
    return `${h12}:${min} ${ampm}`
  }
  try {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    }
  } catch {
    /* fall through */
  }
  return raw
}
