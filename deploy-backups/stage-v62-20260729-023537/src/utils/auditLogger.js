const pool = require('../config/db')
const Sentry = require('@sentry/node')
const { redactSensitiveData, safeAuditDetails } = require('./phiSafeLogger')

let colsReady = false

/**
 * Standard handler for fire-and-forget audit writes. Audit failures must never
 * crash a request, but they also must never be swallowed silently — a missing
 * audit trail is a HIPAA compliance gap. Log it and report to Sentry.
 */
function reportAuditFailure(err) {
    console.error('Audit log failed:', err)
    try {
        Sentry.captureException(err)
    } catch (_) {
        /* Sentry not initialized (e.g. tests) — console.error already happened */
    }
}

const AUDIT_OPTIONAL_COLUMNS = [
    { name: 'ip_address', ddl: `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64)` },
    { name: 'user_agent', ddl: `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT` },
    { name: 'status', ddl: `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS status VARCHAR(24) NOT NULL DEFAULT 'success'` },
    { name: 'module_key', ddl: `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS module_key VARCHAR(64)` },
    { name: 'action_category', ddl: `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action_category VARCHAR(48)` },
    { name: 'event_metadata', ddl: `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS event_metadata JSONB NOT NULL DEFAULT '{}'::jsonb` },
    { name: 'request_path', ddl: `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_path VARCHAR(512)` },
]

const AUDIT_INDEXES = [
    { name: 'idx_audit_logs_created_at', ddl: `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC)` },
    { name: 'idx_audit_logs_user_id', ddl: `CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs (user_id)` },
    { name: 'idx_audit_logs_action', ddl: `CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action)` },
    { name: 'idx_audit_logs_status', ddl: `CREATE INDEX IF NOT EXISTS idx_audit_logs_status ON audit_logs (status)` },
    { name: 'idx_audit_logs_module_key', ddl: `CREATE INDEX IF NOT EXISTS idx_audit_logs_module_key ON audit_logs (module_key)` },
    { name: 'idx_audit_logs_action_category', ddl: `CREATE INDEX IF NOT EXISTS idx_audit_logs_action_category ON audit_logs (action_category)` },
]

async function tableExists(tableName) {
    const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        [tableName],
    )
    return rows.length > 0
}

async function columnExists(tableName, columnName) {
    const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [tableName, columnName],
    )
    return rows.length > 0
}

async function indexExists(indexName) {
    const { rows } = await pool.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
        [indexName],
    )
    return rows.length > 0
}

async function runDdlIfNeeded(ddl, existsCheck) {
    if (await existsCheck()) return
    try {
        await pool.query(ddl)
    } catch (err) {
        if (err.code === '42501' && (await existsCheck())) return
        throw err
    }
}

async function ensureAuditColumns() {
    if (colsReady) return

    if (!(await tableExists('audit_logs'))) {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id BIGSERIAL PRIMARY KEY,
                user_id INTEGER,
                user_name TEXT,
                user_role TEXT,
                action TEXT NOT NULL,
                entity_type TEXT,
                entity_id TEXT,
                details TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                ip_address VARCHAR(64),
                user_agent TEXT,
                status VARCHAR(24) NOT NULL DEFAULT 'success',
                module_key VARCHAR(64),
                action_category VARCHAR(48),
                event_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                request_path VARCHAR(512)
            )
        `)
    } else {
        for (const col of AUDIT_OPTIONAL_COLUMNS) {
            await runDdlIfNeeded(col.ddl, () => columnExists('audit_logs', col.name))
        }
    }

    for (const idx of AUDIT_INDEXES) {
        await runDdlIfNeeded(idx.ddl, () => indexExists(idx.name))
    }

    colsReady = true
}

function requestMeta(req) {
    if (!req) return { ip: null, ua: null, path: null }
    // req.ip respects Express `trust proxy`, so only the proxy-appended hop is
    // trusted. Hand-parsing X-Forwarded-For would let any client spoof the IP
    // recorded in the HIPAA audit log.
    const ip = req.ip || req.socket?.remoteAddress || null
    const uaRaw = (req.headers && req.headers['user-agent']) || ''
    const ua = String(uaRaw).slice(0, 2000)
    const path = String(req.originalUrl || req.url || '').slice(0, 512)
    return { ip: ip ? ip.slice(0, 64) : null, ua, path }
}

function inferActionCategory(action) {
    const a = String(action || '')
    if (/^(LOGIN_|LOGOUT)/.test(a)) return 'authentication'
    if (/ADMIN_MODULES|PASSWORD|CHANGE_PASSWORD|PERMISSION/.test(a)) return 'authorization'
    if (/SUBMITTED|ASSIGNED|REGISTERED|ACTIVATED|ENDED|CREATED|VISIT_ENDED/.test(a)) return 'create'
    if (/UPDATED|EDIT_REQUESTED|RATE_/.test(a)) return 'update'
    if (/DELETED|DEACTIVATED|UNASSIGNED|REMOVED/.test(a)) return 'delete'
    if (/PORTAL_ACCESS/.test(a)) return 'module_access'
    return 'other'
}

/**
 * Append-only audit row. Pass `options.client` for transactional writes.
 * Back-compat: 6th arg may be a pg client (pool or client from withTransaction).
 */
async function auditLog(user, action, entityType, entityId, details, sixth, seventh) {
    await ensureAuditColumns()
    let client = pool
    let options = {}
    if (sixth && typeof sixth.query === 'function') {
        client = sixth
        if (seventh && typeof seventh === 'object' && seventh !== null) options = { ...seventh }
    } else if (sixth && typeof sixth === 'object' && sixth !== null) {
        options = { ...sixth }
        if (options.client && typeof options.client.query === 'function') client = options.client
    }

    const status = (options.status || 'success').toString().slice(0, 24)
    const module_key = options.module_key != null ? String(options.module_key).slice(0, 64) : null
    const action_category = (options.action_category || inferActionCategory(action)).toString().slice(0, 48)
    const metaObj = options.metadata != null && typeof options.metadata === 'object'
      ? redactSensitiveData(options.metadata)
      : {}
    const { ip, ua, path } = requestMeta(options.req)

    await client.query(
        `INSERT INTO audit_logs
         (user_id, user_name, user_role, action, entity_type, entity_id, details,
          ip_address, user_agent, status, module_key, action_category, event_metadata, request_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
        [
            user?.id ?? null,
            user?.name != null ? String(user.name).slice(0, 500) : 'System',
            user?.role != null ? String(user.role).slice(0, 64) : 'system',
            String(action).slice(0, 160),
            entityType != null ? String(entityType).slice(0, 64) : null,
            entityId != null ? String(entityId).slice(0, 160) : null,
            details != null ? safeAuditDetails(details) : null,
            ip,
            ua || null,
            status,
            module_key,
            action_category,
            JSON.stringify(metaObj),
            path,
        ],
    )
}

module.exports = { auditLog, ensureAuditColumns, inferActionCategory, requestMeta, reportAuditFailure }
