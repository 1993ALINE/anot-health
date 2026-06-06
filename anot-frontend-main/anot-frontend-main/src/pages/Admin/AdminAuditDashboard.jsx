import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    ResponsiveContainer,
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    BarChart,
    Bar,
    Cell,
} from 'recharts'
import { adminAPI, settingsAPI } from '../../services/api'
import { isSuperAdmin } from '../../auth/roles'
import { ConfirmDialog } from '../shared'
import { auditBucketDateKey, formatAuditBucketDayUTC, formatAuditDateTime, parseAuditInstant } from '../../utils/auditDateTime'
import './adminAudit.css'

const STATUS_STYLES = {
    success: 'adm-auditpro-status--success',
    failed: 'adm-auditpro-status--failed',
    warning: 'adm-auditpro-status--warning',
    critical: 'adm-auditpro-status--critical',
}

const MODULE_FILTER = [
    { value: '', label: 'All modules' },
    { value: 'overview', label: 'Overview' },
    { value: 'admins', label: 'Admins' },
    { value: 'assignments', label: 'Assignments' },
    { value: 'payroll', label: 'Payroll' },
    { value: 'performance', label: 'Performance' },
    { value: 'audit', label: 'Audit' },
    { value: 'settings', label: 'Settings' },
    { value: 'clinical', label: 'Clinical' },
]

const CATEGORY_FILTER = [
    { value: '', label: 'All categories' },
    { value: 'authentication', label: 'Authentication' },
    { value: 'authorization', label: 'Authorization' },
    { value: 'create', label: 'Create' },
    { value: 'update', label: 'Update' },
    { value: 'delete', label: 'Delete' },
    { value: 'module_access', label: 'Module access' },
    { value: 'other', label: 'Other' },
]

const STATUS_FILTER = [
    { value: '', label: 'All statuses' },
    { value: 'success', label: 'Success' },
    { value: 'failed', label: 'Failed' },
    { value: 'warning', label: 'Warning' },
    { value: 'critical', label: 'Critical' },
]

const ROLE_FILTER = [
    { value: '', label: 'All roles' },
    { value: 'super_admin', label: 'Super Admin' },
    { value: 'admin', label: 'Admin' },
    { value: 'clinician', label: 'Clinician' },
    { value: 'scribe', label: 'Scribe' },
    { value: 'qps', label: 'QPS' },
    { value: 'anonymous', label: 'Anonymous' },
    { value: 'system', label: 'System' },
]

function shortDevice(ua) {
    if (!ua) return '—'
    const s = String(ua)
    if (/Mobile/i.test(s)) return 'Mobile browser'
    if (/Tablet|iPad/i.test(s)) return 'Tablet'
    if (/Windows/i.test(s)) return 'Windows · desktop'
    if (/Mac OS X/i.test(s)) return 'macOS · desktop'
    if (/Linux/i.test(s)) return 'Linux · desktop'
    if (/Android/i.test(s)) return 'Android'
    if (/iPhone|iOS/i.test(s)) return 'iOS'
    return 'Desktop / other'
}

function formatActionLabel(action) {
    if (!action) return '—'
    return String(action)
        .split('_')
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(' ')
}

function isRiskRow(log) {
    if (log.status === 'critical' || log.status === 'failed') return true
    if (log.action === 'LOGIN_FAILED' || log.action === 'USER_DELETED') return true
    return false
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
}

function buildQueryParams(filters, extra = {}) {
    const p = new URLSearchParams()
    Object.entries({ ...filters, ...extra }).forEach(([k, v]) => {
        if (v !== '' && v != null) p.set(k, String(v))
    })
    return p
}

export default function AdminAuditDashboard({ showToast, currentUser, onMeta }) {
    const [summary, setSummary] = useState(null)
    const [summaryLoading, setSummaryLoading] = useState(true)
    const [logs, setLogs] = useState([])
    const [total, setTotal] = useState(0)
    const [page, setPage] = useState(1)
    const [pageSize] = useState(25)
    const [tableLoading, setTableLoading] = useState(true)
    const [live, setLive] = useState(true)
    const [selected, setSelected] = useState(null)
    const [retentionDays, setRetentionDays] = useState(365)
    const [retentionSaving, setRetentionSaving] = useState(false)
    const [settingsSnapshot, setSettingsSnapshot] = useState(null)
    const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false)
    const [purgeLoading, setPurgeLoading] = useState(false)
    const prevSigRef = useRef('')

    const [q, setQ] = useState('')
    const [role, setRole] = useState('')
    const [module, setModule] = useState('')
    const [action, setAction] = useState('')
    const [actionCategory, setActionCategory] = useState('')
    const [status, setStatus] = useState('')
    const [dateFrom, setDateFrom] = useState('')
    const [dateTo, setDateTo] = useState('')
    const [userId, setUserId] = useState('')

    const listFilters = useMemo(
        () => ({
            q,
            role,
            module,
            action,
            action_category: actionCategory,
            status,
            date_from: dateFrom,
            date_to: dateTo,
            user_id: userId,
        }),
        [q, role, module, action, actionCategory, status, dateFrom, dateTo, userId]
    )

    const loadSummary = useCallback(async () => {
        try {
            const data = await adminAPI.getAuditSummary({ days: 14 })
            setSummary(data)
        } catch (err) {
            showToast?.(err.message || 'Failed to load audit analytics', 'error')
        } finally {
            setSummaryLoading(false)
        }
    }, [showToast])

    const loadLogs = useCallback(async () => {
        setTableLoading(true)
        try {
            const data = await adminAPI.getAuditLogs({
                ...listFilters,
                page,
                pageSize,
            })
            const rows = data.logs || []
            setLogs(rows)
            setTotal(Number(data.total) || rows.length)

            const sig = rows.length ? `${rows[0].id}:${rows[0].created_at}` : ''
            if (live && page === 1 && prevSigRef.current && sig && prevSigRef.current !== sig) {
                const top = rows[0]
                if (top && (top.status === 'critical' || top.action === 'LOGIN_FAILED')) {
                    showToast?.(`New activity: ${formatActionLabel(top.action)}`, 'warning')
                }
            }
            prevSigRef.current = sig
        } catch (err) {
            showToast?.(err.message || 'Failed to load audit log', 'error')
            setLogs([])
            setTotal(0)
        } finally {
            setTableLoading(false)
        }
    }, [listFilters, page, pageSize, live, showToast])

    const loadRetention = useCallback(async () => {
        if (!isSuperAdmin(currentUser)) return
        try {
            const data = await settingsAPI.getInternal()
            const s = data.settings || {}
            setSettingsSnapshot(s)
            if (s.audit_retention_days != null) setRetentionDays(Number(s.audit_retention_days))
        } catch {
            /* optional */
        }
    }, [currentUser])

    useEffect(() => {
        void loadSummary()
    }, [loadSummary])

    useEffect(() => {
        void loadLogs()
    }, [loadLogs])

    useEffect(() => {
        void loadRetention()
    }, [loadRetention])

    useEffect(() => {
        onMeta?.({
            total,
            filtered: total,
            page,
            alerts: summary?.alerts?.length ?? 0,
        })
    }, [onMeta, total, page, summary])

    useEffect(() => {
        if (!live) return undefined
        const id = setInterval(() => {
            void loadSummary()
            if (page === 1) void loadLogs()
        }, 14000)
        return () => clearInterval(id)
    }, [live, loadSummary, loadLogs, page])

    const dailyChart = useMemo(() => {
        const rows = summary?.daily_activity || []
        return rows.map((r) => {
            const key = auditBucketDateKey(r.date)
            return {
                label: key ? formatAuditBucketDayUTC(key) : '',
                full: key,
                events: r.count,
            }
        })
    }, [summary])

    const topUsersChart = useMemo(() => {
        return (summary?.top_users || []).map((u) => ({
            name: (u.user_name || `User #${u.user_id}`).slice(0, 14),
            events: u.event_count,
        }))
    }, [summary])

    const moduleColors = ['#4260E9', '#7B61FF', '#0d9488', '#b45309', '#64748b', '#e11d48', '#2563eb', '#059669']

    const onExport = async (format) => {
        try {
            const blob = await adminAPI.exportAuditLogs(format, listFilters)
            const ext = format === 'xlsx' ? 'xlsx' : format === 'pdf' ? 'pdf' : 'csv'
            downloadBlob(blob, `audit-export.${ext}`)
            showToast?.(`Exported ${ext.toUpperCase()}`, 'success')
        } catch (err) {
            showToast?.(err.message || 'Export failed', 'error')
        }
    }

    const onApplyRetention = async () => {
        if (!isSuperAdmin(currentUser)) return
        setPurgeLoading(true)
        try {
            const data = await adminAPI.applyAuditRetention()
            showToast?.(`Retention applied: removed ${data.deleted} row(s).`, 'success')
            prevSigRef.current = ''
            void loadSummary()
            void loadLogs()
            setPurgeConfirmOpen(false)
        } catch (err) {
            showToast?.(err.message || 'Retention failed', 'error')
        } finally {
            setPurgeLoading(false)
        }
    }

    const onSaveRetention = async () => {
        if (!settingsSnapshot) {
            showToast?.('Open Settings tab once to sync, or retry.', 'error')
            return
        }
        setRetentionSaving(true)
        try {
            await settingsAPI.update({
                ...settingsSnapshot,
                audit_retention_days: Math.max(30, Math.min(Number(retentionDays) || 365, 3650)),
            })
            showToast?.('Audit retention policy saved.', 'success')
        } catch (err) {
            showToast?.(err.message || 'Save failed', 'error')
        } finally {
            setRetentionSaving(false)
        }
    }

    const totalPages = Math.max(1, Math.ceil(total / pageSize))

    return (
        <div className="adm-auditpro">
            <ConfirmDialog
                dialog={purgeConfirmOpen ? {
                    tone: 'danger',
                    title: 'Delete audit logs?',
                    message: `This will permanently delete audit logs older than ${retentionDays} days. This cannot be undone. Are you sure?`,
                    confirmText: 'Delete Logs',
                    cancelText: 'Cancel',
                } : null}
                loading={purgeLoading}
                onDismiss={() => !purgeLoading && setPurgeConfirmOpen(false)}
                onConfirm={onApplyRetention}
            />
            {summary?.alerts?.length > 0 && (
                <div className="adm-auditpro__alerts" role="status">
                    {summary.alerts.map((a) => (
                        <div key={a.code} className={`adm-auditpro-alert adm-auditpro-alert--${a.level === 'critical' ? 'critical' : 'warning'}`}>
                            <span className="adm-auditpro-alert__ico" aria-hidden>
                                {a.level === 'critical' ? '🛡' : '⚠️'}
                            </span>
                            <div className="adm-auditpro-alert__msg">{a.message}</div>
                        </div>
                    ))}
                </div>
            )}

            <div className="adm-auditpro__kpis">
                {[
                    { label: 'All-time events', value: summary?.totals?.all_time ?? '—', hint: 'Immutable append-only log' },
                    { label: 'Today (UTC)', value: summary?.totals?.today_utc ?? '—', hint: 'Resets on UTC midnight' },
                    { label: 'Failed sign-ins (7d)', value: summary?.totals?.failed_logins_7d ?? '—', hint: 'Authentication risk signal' },
                    { label: 'Critical (30d)', value: summary?.totals?.critical_30d ?? '—', hint: 'High-severity markers' },
                ].map((k) => (
                    <div key={k.label} className="adm-auditpro-kpi">
                        <div className="adm-auditpro-kpi__label">{k.label}</div>
                        <div className="adm-auditpro-kpi__value">{k.value}</div>
                        <div className="adm-auditpro-kpi__hint">{k.hint}</div>
                    </div>
                ))}
            </div>

            <div className="adm-auditpro__charts">
                <div className="adm-auditpro-chartcard">
                    <div className="adm-auditpro-chartcard__title">Daily activity (by UTC calendar day)</div>
                    {summaryLoading ? (
                        <div className="adm-auditpro-skel" style={{ height: 180 }} />
                    ) : (
                        <ResponsiveContainer width="100%" height={200}>
                            <AreaChart data={dailyChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="auditArea" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="var(--brand-primary, #4260E9)" stopOpacity={0.35} />
                                        <stop offset="100%" stopColor="var(--brand-primary, #4260E9)" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                                <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="#94a3b8" />
                                <YAxis width={32} tick={{ fontSize: 10 }} stroke="#94a3b8" allowDecimals={false} />
                                <Tooltip
                                    contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                                    formatter={(v) => [`${v} events`, 'Count']}
                                    labelFormatter={(_, p) => {
                                        const key = p?.[0]?.payload?.full
                                        return key ? `${key} (UTC)` : ''
                                    }}
                                />
                                <Area type="monotone" dataKey="events" stroke="var(--brand-primary, #4260E9)" fill="url(#auditArea)" strokeWidth={2} />
                            </AreaChart>
                        </ResponsiveContainer>
                    )}
                </div>
                <div className="adm-auditpro-chartcard">
                    <div className="adm-auditpro-chartcard__title">Most active users (30d)</div>
                    {summaryLoading ? (
                        <div className="adm-auditpro-skel" style={{ height: 180 }} />
                    ) : (
                        <ResponsiveContainer width="100%" height={200}>
                            <BarChart data={topUsersChart} layout="vertical" margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                                <XAxis type="number" tick={{ fontSize: 10 }} stroke="#94a3b8" allowDecimals={false} />
                                <YAxis type="category" dataKey="name" width={88} tick={{ fontSize: 10 }} stroke="#94a3b8" />
                                <Tooltip contentStyle={{ borderRadius: 10, fontSize: 12 }} />
                                <Bar dataKey="events" radius={[0, 6, 6, 0]}>
                                    {topUsersChart.map((_, i) => (
                                        <Cell key={i} fill={moduleColors[i % moduleColors.length]} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    )}
                </div>
                <div className="adm-auditpro-chartcard">
                    <div className="adm-auditpro-chartcard__title">Modules (30d)</div>
                    {summaryLoading ? (
                        <div className="adm-auditpro-skel" style={{ height: 180 }} />
                    ) : (
                        <ResponsiveContainer width="100%" height={200}>
                            <BarChart data={summary?.top_modules || []} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                                <XAxis dataKey="module_key" tick={{ fontSize: 9 }} stroke="#94a3b8" interval={0} angle={-18} textAnchor="end" height={54} />
                                <YAxis width={28} tick={{ fontSize: 10 }} stroke="#94a3b8" allowDecimals={false} />
                                <Tooltip contentStyle={{ borderRadius: 10, fontSize: 12 }} />
                                <Bar dataKey="n" fill="var(--brand-secondary, #7B61FF)" radius={[6, 6, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    )}
                </div>
            </div>

            <div className="adm-auditpro-sticky">
                <div className="adm-auditpro-toolbar">
                    <input
                        className="adm-input adm-input--audit adm-auditpro-input adm-auditpro-toolbar__grow"
                        placeholder="Search details, action, user…"
                        value={q}
                        onChange={(e) => {
                            setPage(1)
                            setQ(e.target.value)
                        }}
                    />
                    <input
                        className="adm-input adm-input--select-compact adm-auditpro-input"
                        placeholder="User ID"
                        value={userId}
                        onChange={(e) => {
                            setPage(1)
                            setUserId(e.target.value.replace(/\D/g, '').slice(0, 12))
                        }}
                        inputMode="numeric"
                        style={{ maxWidth: 110 }}
                    />
                    <select className="adm-input adm-input--select-compact adm-auditpro-select" value={role} onChange={(e) => { setPage(1); setRole(e.target.value) }}>
                        {ROLE_FILTER.map((o) => (
                            <option key={o.value || 'all'} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                    <select className="adm-input adm-input--select-compact adm-auditpro-select" value={module} onChange={(e) => { setPage(1); setModule(e.target.value) }}>
                        {MODULE_FILTER.map((o) => (
                            <option key={o.value || 'allm'} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                    <select className="adm-input adm-input--select-compact adm-auditpro-select" value={actionCategory} onChange={(e) => { setPage(1); setActionCategory(e.target.value) }}>
                        {CATEGORY_FILTER.map((o) => (
                            <option key={o.value || 'allc'} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                    <select className="adm-input adm-input--select-compact adm-auditpro-select" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value) }}>
                        {STATUS_FILTER.map((o) => (
                            <option key={o.value || 'alls'} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                    <input
                        type="date"
                        className="adm-input adm-input--select-compact"
                        value={dateFrom}
                        onChange={(e) => { setPage(1); setDateFrom(e.target.value) }}
                    />
                    <input
                        type="date"
                        className="adm-input adm-input--select-compact"
                        value={dateTo}
                        onChange={(e) => { setPage(1); setDateTo(e.target.value) }}
                    />
                    <input
                        className="adm-input adm-input--select-wide adm-auditpro-input"
                        placeholder="Exact action code (e.g. LOGIN_SUCCESS)"
                        value={action}
                        onChange={(e) => { setPage(1); setAction(e.target.value) }}
                    />
                    <div className="adm-auditpro-toolbar__actions">
                        <button
                            type="button"
                            className={`adm-auditpro-live ${live ? 'adm-auditpro-live--on' : ''}`}
                            onClick={() => setLive((v) => !v)}
                            title="Poll for new events every ~14s when on page 1"
                        >
                            <span className="adm-auditpro-live__dot" aria-hidden />
                            Live
                        </button>
                        <button type="button" className="adm-auditpro-btn adm-auditpro-btn--ghost" onClick={() => { void loadSummary(); void loadLogs() }}>
                            Refresh
                        </button>
                        <button type="button" className="adm-auditpro-btn" onClick={() => onExport('csv')}>
                            CSV
                        </button>
                        <button type="button" className="adm-auditpro-btn" onClick={() => onExport('xlsx')}>
                            Excel
                        </button>
                        <button type="button" className="adm-auditpro-btn" onClick={() => onExport('pdf')}>
                            PDF
                        </button>
                    </div>
                </div>
            </div>

            {isSuperAdmin(currentUser) && (
                <div className="adm-auditpro-retention">
                    <strong>Retention policy</strong> — events older than the configured number of days can be purged by Super Admin (append-only until purge; no edits).
                    <div className="adm-auditpro-retention__row">
                        <label className="adm-form-label" style={{ margin: 0 }}>
                            Days to retain
                            <input
                                type="number"
                                className="adm-input"
                                style={{ marginLeft: 8, width: 100 }}
                                min={30}
                                max={3650}
                                value={retentionDays}
                                onChange={(e) => setRetentionDays(Number(e.target.value))}
                            />
                        </label>
                        <button type="button" className="adm-btn-primary" disabled={retentionSaving} onClick={onSaveRetention}>
                            {retentionSaving ? 'Saving…' : 'Save policy'}
                        </button>
                        <button type="button" className="adm-btn-action" style={{ color: '#b45309' }} onClick={() => setPurgeConfirmOpen(true)}>
                            Apply purge now
                        </button>
                    </div>
                </div>
            )}

            <div className="adm-auditpro-tablewrap">
                {tableLoading ? (
                    <div className="adm-loading-panel" style={{ padding: 24 }} aria-busy="true">
                        <div className="adm-skeleton adm-skeleton--head" />
                        <div className="adm-skeleton-rows">
                            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                                <div key={i} className="adm-skeleton adm-skeleton--row" />
                            ))}
                        </div>
                    </div>
                ) : logs.length === 0 ? (
                    <div className="adm-empty-state" style={{ padding: 48 }}>
                        <div className="adm-empty-state__icon">🔍</div>
                        <div className="adm-empty-state__title">No audit events match</div>
                        <p className="adm-empty-state__hint">Broaden filters or verify the database migration has run on the API host.</p>
                    </div>
                ) : (
                    <div className="adm-auditpro-table-scroll">
                        <table className="adm-auditpro-table">
                            <thead>
                                <tr>
                                    <th>Status</th>
                                    <th>Occurred (your time)</th>
                                    <th>User</th>
                                    <th>Role</th>
                                    <th>Module</th>
                                    <th>Category</th>
                                    <th>Action</th>
                                    <th>IP</th>
                                    <th>Device</th>
                                    <th>Details</th>
                                    <th style={{ width: 90 }}> </th>
                                </tr>
                            </thead>
                            <tbody>
                                {logs.map((log) => (
                                    <tr key={log.id} className={isRiskRow(log) ? 'adm-auditpro-row--risk' : ''}>
                                        <td>
                                            <span className={`adm-auditpro-status ${STATUS_STYLES[log.status] || 'adm-auditpro-status--success'}`}>
                                                {log.status || 'success'}
                                            </span>
                                        </td>
                                        <td className="adm-auditpro-mono">{formatAuditDateTime(log.created_at)}</td>
                                        <td>{log.user_name || '—'}</td>
                                        <td>{log.user_role || '—'}</td>
                                        <td>{log.module_key || '—'}</td>
                                        <td>{log.action_category || '—'}</td>
                                        <td>{formatActionLabel(log.action)}</td>
                                        <td className="adm-auditpro-mono">{log.ip_address || '—'}</td>
                                        <td>{shortDevice(log.user_agent_full || log.user_agent)}</td>
                                        <td style={{ maxWidth: 220, lineHeight: 1.35, color: 'var(--text-muted)' }}>
                                            {(log.details || '—').slice(0, 160)}
                                            {(log.details || '').length > 160 ? '…' : ''}
                                        </td>
                                        <td>
                                            <button type="button" className="adm-auditpro-btn" onClick={() => setSelected(log)}>
                                                View
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                <div className="adm-auditpro-pagination">
                    <span>
                        Page {page} / {totalPages} · {total} events
                    </span>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button type="button" className="adm-auditpro-btn adm-auditpro-btn--ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                            Previous
                        </button>
                        <button type="button" className="adm-auditpro-btn adm-auditpro-btn--ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                            Next
                        </button>
                    </div>
                </div>
            </div>

            {selected && (
                <>
                    <div className="adm-auditpro-drawer-backdrop" role="presentation" onClick={() => setSelected(null)} />
                    <aside className="adm-auditpro-drawer" role="dialog" aria-modal="true" aria-labelledby="adm-audit-drawer-title">
                        <div className="adm-auditpro-drawer__head">
                            <div>
                                <div id="adm-audit-drawer-title" className="adm-auditpro-drawer__title">
                                    Activity detail
                                </div>
                                <div className="adm-auditpro-mono" style={{ marginTop: 4 }}>
                                    #{selected.id}
                                </div>
                            </div>
                            <button type="button" className="adm-auditpro-drawer__close" aria-label="Close" onClick={() => setSelected(null)}>
                                ×
                            </button>
                        </div>
                        <div className="adm-auditpro-drawer__body">
                            <div className="adm-auditpro-timeline">
                                <div className="adm-auditpro-timeline__item">
                                    <span className="adm-auditpro-timeline__dot" aria-hidden />
                                    <div className={`adm-auditpro-status ${STATUS_STYLES[selected.status] || 'adm-auditpro-status--success'}`} style={{ marginBottom: 10 }}>
                                        {selected.status || 'success'}
                                    </div>
                                    <dl className="adm-auditpro-dl">
                                        <dt>Timestamp</dt>
                                        <dd>
                                            {(() => {
                                                const d = parseAuditInstant(selected.created_at)
                                                if (!d) return '—'
                                                return (
                                                    <>
                                                        <div>{formatAuditDateTime(d)}</div>
                                                        <div className="adm-auditpro-mono" style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                                                            {`ISO (UTC): ${d.toISOString()}`}
                                                        </div>
                                                    </>
                                                )
                                            })()}
                                        </dd>
                                        <dt>Actor</dt>
                                        <dd>
                                            {selected.user_name || '—'} ({selected.user_role || '—'}) #{selected.user_id ?? '—'}
                                        </dd>
                                        <dt>Action</dt>
                                        <dd>{selected.action}</dd>
                                        <dt>Category</dt>
                                        <dd>{selected.action_category || '—'}</dd>
                                        <dt>Module</dt>
                                        <dd>{selected.module_key || '—'}</dd>
                                        <dt>Entity</dt>
                                        <dd>
                                            {selected.entity_type || '—'} {selected.entity_id ? `#${selected.entity_id}` : ''}
                                        </dd>
                                        <dt>IP</dt>
                                        <dd className="adm-auditpro-mono">{selected.ip_address || '—'}</dd>
                                        <dt>Request</dt>
                                        <dd className="adm-auditpro-mono">{selected.request_path || '—'}</dd>
                                        <dt>User-Agent</dt>
                                        <dd className="adm-auditpro-mono" style={{ fontSize: 11 }}>
                                            {selected.user_agent_full || selected.user_agent || '—'}
                                        </dd>
                                        <dt>Details</dt>
                                        <dd>{selected.details || '—'}</dd>
                                        <dt>Metadata</dt>
                                        <dd className="adm-auditpro-mono" style={{ fontSize: 11 }}>
                                            {selected.event_metadata && Object.keys(selected.event_metadata).length
                                                ? JSON.stringify(selected.event_metadata, null, 2)
                                                : '—'}
                                        </dd>
                                    </dl>
                                </div>
                            </div>
                        </div>
                    </aside>
                </>
            )}
        </div>
    )
}
