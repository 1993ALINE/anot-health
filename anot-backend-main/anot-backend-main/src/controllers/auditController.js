const pool = require('../config/db')
const { withTransaction } = require('../config/db')
const { ensureAuditColumns } = require('../utils/auditLogger')

// HIPAA §164.316(b)(2) requires retention of compliance records for 6 years.
// We default to 7 years (2555 days) to keep a safety margin.
const DEFAULT_AUDIT_RETENTION_DAYS = 2555
const { isSuperAdmin } = require('../utils/roles')

const MAX_PAGE_SIZE = 500
const MAX_EXPORT_ROWS = 5000

function parseIntSafe(v, fallback) {
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : fallback
}

function applyListFilters(query, params) {
    let sql = ' WHERE 1=1 '

    const userId = parseIntSafe(query.user_id, NaN)
    if (Number.isFinite(userId)) {
        params.push(userId)
        sql += ` AND user_id = $${params.length}`
    }

    if (query.role) {
        params.push(String(query.role).slice(0, 64))
        sql += ` AND user_role = $${params.length}`
    }

    if (query.module) {
        params.push(String(query.module).slice(0, 64))
        sql += ` AND module_key = $${params.length}`
    }

    if (query.action) {
        params.push(String(query.action).slice(0, 160))
        sql += ` AND action = $${params.length}`
    }

    if (query.action_category) {
        params.push(String(query.action_category).slice(0, 48))
        sql += ` AND action_category = $${params.length}`
    }

    if (query.status) {
        params.push(String(query.status).slice(0, 24))
        sql += ` AND status = $${params.length}`
    }

    if (query.date_from) {
        params.push(String(query.date_from).slice(0, 10))
        sql += ` AND (created_at AT TIME ZONE 'UTC')::date >= $${params.length}::date`
    }

    if (query.date_to) {
        params.push(String(query.date_to).slice(0, 10))
        sql += ` AND (created_at AT TIME ZONE 'UTC')::date <= $${params.length}::date`
    }

    const q = (query.q || '').trim()
    if (q) {
        const like = `%${q.slice(0, 200)}%`
        params.push(like)
        const iLike = params.length
        let block = `(details ILIKE $${iLike} OR action ILIKE $${iLike} OR user_name ILIKE $${iLike})`
        if (/^\d+$/.test(q)) {
            params.push(parseInt(q, 10))
            block = `(${block} OR user_id = $${params.length})`
        }
        sql += ` AND ${block}`
    }

    return sql
}

function rowForClient(row) {
    const ua = row.user_agent ? String(row.user_agent) : ''
    const shortUa = ua.length > 120 ? `${ua.slice(0, 117)}…` : ua
    return { ...row, user_agent: shortUa, user_agent_full: ua }
}

const listAuditLogs = async (req, res) => {
    try {
        await ensureAuditColumns()
        if (!req.query.page && req.query.limit) {
            req.query.page = 1
            req.query.pageSize = Math.min(Math.max(parseIntSafe(req.query.limit, 200), 1), MAX_PAGE_SIZE)
        }
        const pageSize = Math.min(Math.max(parseIntSafe(req.query.pageSize, 25), 1), MAX_PAGE_SIZE)
        const page = Math.max(parseIntSafe(req.query.page, 1), 1)
        const offset = (page - 1) * pageSize

        const filterParams = []
        const where = applyListFilters(req.query, filterParams)
        const countResult = await pool.query(`SELECT COUNT(*)::bigint AS c FROM audit_logs ${where}`, filterParams)
        const total = Number(countResult.rows[0]?.c || 0)

        const listParams = [...filterParams, pageSize, offset]
        const limIdx = listParams.length - 1
        const offIdx = listParams.length
        const result = await pool.query(
            `SELECT * FROM audit_logs ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT $${limIdx} OFFSET $${offIdx}`,
            listParams
        )

        res.json({
            logs: result.rows.map(rowForClient),
            total,
            page,
            pageSize,
        })
    } catch (err) {
        console.error('listAuditLogs:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

const getAuditSummary = async (req, res) => {
    try {
        await ensureAuditColumns()
        const days = Math.min(Math.max(parseIntSafe(req.query.days, 14), 1), 90)

        const since = new Date()
        since.setUTCDate(since.getUTCDate() - (days - 1))
        since.setUTCHours(0, 0, 0, 0)

        const [
            totalRow,
            todayRow,
            failedLoginRow,
            criticalRow,
            daily,
            topUsers,
            topModules,
            statusMix,
            failed24h,
        ] = await Promise.all([
            pool.query(`SELECT COUNT(*)::bigint AS c FROM audit_logs`),
            pool.query(
                `SELECT COUNT(*)::bigint AS c FROM audit_logs
                 WHERE (created_at AT TIME ZONE 'UTC')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`
            ),
            pool.query(
                `SELECT COUNT(*)::bigint AS c FROM audit_logs
                 WHERE action = 'LOGIN_FAILED' AND created_at >= NOW() - INTERVAL '7 days'`
            ),
            pool.query(
                `SELECT COUNT(*)::bigint AS c FROM audit_logs
                 WHERE status = 'critical' AND created_at >= NOW() - INTERVAL '30 days'`
            ),
            pool.query(
                `SELECT (created_at AT TIME ZONE 'UTC')::date AS d, COUNT(*)::int AS n
                 FROM audit_logs
                 WHERE created_at >= $1::timestamptz
                 GROUP BY 1 ORDER BY 1 ASC`,
                [since.toISOString()]
            ),
            pool.query(
                `SELECT user_id, MAX(user_name) AS user_name, MAX(user_role) AS user_role, COUNT(*)::int AS event_count
                 FROM audit_logs
                 WHERE created_at >= NOW() - INTERVAL '30 days' AND user_id IS NOT NULL
                 GROUP BY user_id
                 ORDER BY event_count DESC
                 LIMIT 8`
            ),
            pool.query(
                `SELECT module_key, COUNT(*)::int AS n
                 FROM audit_logs
                 WHERE created_at >= NOW() - INTERVAL '30 days' AND module_key IS NOT NULL AND module_key <> ''
                 GROUP BY module_key
                 ORDER BY n DESC
                 LIMIT 8`
            ),
            pool.query(
                `SELECT status, COUNT(*)::int AS n
                 FROM audit_logs
                 WHERE created_at >= NOW() - INTERVAL '14 days'
                 GROUP BY status`
            ),
            pool.query(
                `SELECT COUNT(*)::bigint AS c FROM audit_logs
                 WHERE action = 'LOGIN_FAILED' AND created_at >= NOW() - INTERVAL '24 hours'`
            ),
        ])

        const f24 = Number(failed24h.rows[0]?.c || 0)
        const alerts = []
        if (f24 >= 15) {
            alerts.push({ level: 'critical', code: 'auth_bruteforce_risk', message: `${f24} failed sign-in attempts in the last 24 hours.` })
        } else if (f24 >= 8) {
            alerts.push({ level: 'warning', code: 'auth_spike', message: `${f24} failed sign-in attempts in the last 24 hours.` })
        }
        const crit = Number(criticalRow.rows[0]?.c || 0)
        if (crit > 0) {
            alerts.push({ level: 'critical', code: 'critical_events', message: `${crit} critical-severity events in the last 30 days.` })
        }

        res.json({
            totals: {
                all_time: Number(totalRow.rows[0]?.c || 0),
                today_utc: Number(todayRow.rows[0]?.c || 0),
                failed_logins_7d: Number(failedLoginRow.rows[0]?.c || 0),
                failed_logins_24h: f24,
                critical_30d: crit,
            },
            daily_activity: daily.rows.map((r) => ({ date: r.d, count: r.n })),
            top_users: topUsers.rows,
            top_modules: topModules.rows,
            status_mix: statusMix.rows,
            alerts,
        })
    } catch (err) {
        console.error('getAuditSummary:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

function csvEscape(s) {
    if (s == null) return ''
    let t = String(s)
    // Neutralize spreadsheet formula injection: cells starting with = + - @
    // (or tab/CR) execute as formulas when the export is opened in Excel/Sheets.
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`
    t = t.replace(/"/g, '""')
    return `"${t}"`
}

const exportAuditLogs = async (req, res) => {
    try {
        await ensureAuditColumns()
        const format = String(req.query.format || 'csv').toLowerCase()
        if (!['csv', 'xlsx', 'pdf'].includes(format)) {
            return res.status(400).json({ error: 'Invalid format. Use csv, xlsx, or pdf.' })
        }

        const params = []
        const where = applyListFilters(req.query, params)
        params.push(MAX_EXPORT_ROWS)
        const lim = params.length
        const result = await pool.query(
            `SELECT id, created_at, user_id, user_name, user_role, action, action_category,
                    entity_type, entity_id, status, module_key, ip_address,
                    LEFT(user_agent, 512) AS user_agent, details, event_metadata, request_path
             FROM audit_logs ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT $${lim}`,
            params
        )
        const rows = result.rows

        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

        if (format === 'csv') {
            const headers = [
                'id', 'created_at', 'user_id', 'user_name', 'user_role', 'action', 'action_category',
                'entity_type', 'entity_id', 'status', 'module_key', 'ip_address', 'user_agent',
                'details', 'request_path', 'event_metadata',
            ]
            const lines = [headers.join(',')]
            for (const r of rows) {
                const meta = r.event_metadata != null ? JSON.stringify(r.event_metadata) : ''
                lines.push([
                    r.id,
                    r.created_at,
                    r.user_id ?? '',
                    csvEscape(r.user_name),
                    csvEscape(r.user_role),
                    csvEscape(r.action),
                    csvEscape(r.action_category),
                    csvEscape(r.entity_type),
                    csvEscape(r.entity_id),
                    csvEscape(r.status),
                    csvEscape(r.module_key),
                    csvEscape(r.ip_address),
                    csvEscape(r.user_agent),
                    csvEscape(r.details),
                    csvEscape(r.request_path),
                    csvEscape(meta),
                ].join(','))
            }
            const bom = '\uFEFF'
            res.setHeader('Content-Type', 'text/csv; charset=utf-8')
            res.setHeader('Content-Disposition', `attachment; filename="audit-export-${stamp}.csv"`)
            return res.send(bom + lines.join('\n'))
        }

        if (format === 'xlsx') {
            const ExcelJS = require('exceljs')
            const workbook = new ExcelJS.Workbook()
            const worksheet = workbook.addWorksheet('Audit')
            
            worksheet.columns = [
                { header: 'ID', key: 'id', width: 10 },
                { header: 'Created At', key: 'created_at', width: 20 },
                { header: 'User ID', key: 'user_id', width: 10 },
                { header: 'User Name', key: 'user_name', width: 20 },
                { header: 'User Role', key: 'user_role', width: 15 },
                { header: 'Action', key: 'action', width: 30 },
                { header: 'Action Category', key: 'action_category', width: 20 },
                { header: 'Entity Type', key: 'entity_type', width: 15 },
                { header: 'Entity ID', key: 'entity_id', width: 10 },
                { header: 'Status', key: 'status', width: 10 },
                { header: 'Module Key', key: 'module_key', width: 15 },
                { header: 'IP Address', key: 'ip_address', width: 15 },
                { header: 'User Agent', key: 'user_agent', width: 30 },
                { header: 'Details', key: 'details', width: 30 },
                { header: 'Request Path', key: 'request_path', width: 30 },
                { header: 'Event Metadata', key: 'event_metadata', width: 30 },
            ]
            
            rows.forEach((r) => {
                worksheet.addRow({
                    id: r.id,
                    created_at: r.created_at,
                    user_id: r.user_id,
                    user_name: r.user_name,
                    user_role: r.user_role,
                    action: r.action,
                    action_category: r.action_category,
                    entity_type: r.entity_type,
                    entity_id: r.entity_id,
                    status: r.status,
                    module_key: r.module_key,
                    ip_address: r.ip_address,
                    user_agent: r.user_agent,
                    details: r.details,
                    request_path: r.request_path,
                    event_metadata: r.event_metadata != null ? JSON.stringify(r.event_metadata) : '',
                })
            })
            
            const buf = await workbook.xlsx.writeBuffer()
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            res.setHeader('Content-Disposition', `attachment; filename="audit-export-${stamp}.xlsx"`)
            return res.send(buf)
        }

        const PDFDocument = require('pdfkit')
        const doc = new PDFDocument({ margin: 48, size: 'LETTER', bufferPages: true })
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="audit-export-${stamp}.pdf"`)
        doc.pipe(res)
        doc.fontSize(14).text('Anot — audit log export', { underline: true })
        doc.moveDown(0.5)
        doc.fontSize(9).fillColor('#444').text(`Generated ${new Date().toISOString()} · ${rows.length} row(s) (max ${MAX_EXPORT_ROWS})`, { width: 500 })
        doc.moveDown()
        doc.fillColor('#000')
        let y = doc.y
        const pageBottom = 720
        for (const r of rows) {
            const block = [
                `#${r.id}  ${r.created_at}`,
                `${r.user_name || '—'} (${r.user_role || '—'})  [${r.status}]  ${r.action}`,
                `cat=${r.action_category || '—'}  module=${r.module_key || '—'}  IP=${r.ip_address || '—'}`,
                `${r.details || ''}`,
                '—'.repeat(60),
            ].join('\n')
            doc.fontSize(8)
            const h = doc.heightOfString(block, { width: 500 })
            if (y + h > pageBottom) {
                doc.addPage()
                y = 48
            }
            doc.text(block, 48, y, { width: 500 })
            y = doc.y + 6
        }
        doc.end()
    } catch (err) {
        console.error('exportAuditLogs:', err.message)
        if (!res.headersSent) res.status(500).json({ error: 'Export failed.' })
    }
}

const { addColumnIfMissing } = require('../utils/schemaDdl')

let settingsColsReady = false
async function ensureAuditRetentionColumn() {
    if (settingsColsReady) return
    await addColumnIfMissing(
        'system_settings',
        'audit_retention_days',
        `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS audit_retention_days INTEGER NOT NULL DEFAULT ${DEFAULT_AUDIT_RETENTION_DAYS}`,
    )
    // Enforce a HIPAA-compliant floor: never let retention drop below 6 years
    // (2190 days), and cap at 10 years (3650) to bound table growth.
    await pool.query(`UPDATE system_settings SET audit_retention_days = GREATEST(2190, LEAST(COALESCE(audit_retention_days, ${DEFAULT_AUDIT_RETENTION_DAYS}), 3650)) WHERE id = 1`)
    settingsColsReady = true
}

async function auditLogSafe(user, action, et, eid, det, opts) {
    try {
        const { auditLog } = require('../utils/auditLogger')
        await auditLog(user, action, et, eid, det, opts)
    } catch (_) { /* ignore */ }
}

const applyRetention = async (req, res) => {
    try {
        if (!isSuperAdmin(req.user.role)) {
            return res.status(403).json({ error: 'Only the Super Admin may apply retention purges.' })
        }
        await ensureAuditColumns()
        await ensureAuditRetentionColumn()
        const r = await pool.query('SELECT audit_retention_days FROM system_settings WHERE id = 1')
        const days = Math.max(2190, Math.min(Number(r.rows[0]?.audit_retention_days) || DEFAULT_AUDIT_RETENTION_DAYS, 3650))
        // audit_logs is append-only (enforced by a DB trigger). The retention
        // purge is the ONE sanctioned deleter: it opts in via a transaction-local
        // GUC that the trigger checks, so only rows past the retention window can go.
        const del = await withTransaction(async (client) => {
            await client.query(`SET LOCAL anot.allow_audit_purge = 'on'`)
            return client.query(
                `DELETE FROM audit_logs
                 WHERE created_at < (NOW() - ($1::int * INTERVAL '1 day'))`,
                [days]
            )
        })
        await auditLogSafe(req.user, 'AUDIT_RETENTION_APPLIED', 'audit', null, `Purged events older than ${days} days (${del.rowCount} rows).`, { req, status: 'warning', module_key: 'audit', action_category: 'admin' })
        res.json({ deleted: del.rowCount, retention_days: days })
    } catch (err) {
        console.error('applyRetention:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

module.exports = {
    listAuditLogs,
    getAuditSummary,
    exportAuditLogs,
    applyRetention,
    ensureAuditRetentionColumn,
}
