/**
 * Audit rows use `created_at` from PostgreSQL (timestamptz). Over JSON, values may arrive as
 * ISO strings with `Z`, or as space-separated strings without a zone — those are UTC instants
 * from the server and must not be parsed as local wall time.
 */

function hasExplicitZone(s) {
    return /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)
}

/**
 * @param {string|number|Date|null|undefined} value
 * @returns {Date|null}
 */
export function parseAuditInstant(value) {
    if (value == null) return null
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value
    }
    const s = String(value).trim()
    if (!s) return null
    if (hasExplicitZone(s)) {
        const d = new Date(s)
        return Number.isNaN(d.getTime()) ? null : d
    }
    // "2026-05-12T15:30:00" or "2026-05-12T15:30:00.123" or "2026-05-12 15:30:00" → UTC
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/)
    if (m) {
        const isoUtc = `${m[1]}T${m[2]}Z`
        const d = new Date(isoUtc)
        return Number.isNaN(d.getTime()) ? null : d
    }
    const t = Date.parse(s)
    if (Number.isNaN(t)) return null
    return new Date(t)
}

/**
 * Human-readable instant in the viewer's local timezone.
 * @param {string|number|Date|null|undefined} value
 * @param {{ fallback?: string }} [opts]
 */
export function formatAuditDateTime(value, opts = {}) {
    const d = parseAuditInstant(value)
    if (!d) return opts.fallback ?? '—'
    return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    })
}

/** `YYYY-MM-DD` bucket key from API date field (date or timestamptz). */
export function auditBucketDateKey(raw) {
    if (raw == null) return ''
    if (raw instanceof Date) return raw.toISOString().slice(0, 10)
    const s = String(raw).trim()
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
    return m ? m[1] : ''
}

/** Label for a UTC calendar bucket (daily chart). */
export function formatAuditBucketDayUTC(yyyyMmDd) {
    if (!yyyyMmDd) return ''
    const [y, mo, d] = yyyyMmDd.split('-').map((x) => parseInt(x, 10))
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return yyyyMmDd
    return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    })
}
